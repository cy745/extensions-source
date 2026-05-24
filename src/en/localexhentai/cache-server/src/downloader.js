const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const StreamZip = require('node-stream-zip');
const store = require('./store');

const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const GALLERIES_DIR = path.join(CACHE_DIR, 'galleries');
const SETTINGS_PATH = path.join(CACHE_DIR, 'settings.json');

function buildDefaultCookies() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const parts = [];
    if (s.ipb_member_id) parts.push(`ipb_member_id=${s.ipb_member_id}`);
    if (s.ipb_pass_hash) parts.push(`ipb_pass_hash=${s.ipb_pass_hash}`);
    if (s.igneous) parts.push(`igneous=${s.igneous}`);
    return parts.join('; ');
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// DNS-over-HTTPS resolver (same as index.js)
// ---------------------------------------------------------------------------
const DOH_HOST = '104.16.133.229';
const DOH_HEADERS = { 'accept': 'application/dns-json', 'host': 'cloudflare-dns.com' };
const dnsCache = new Map();
const DNS_CACHE_TTL = 300_000;

function isIpAddress(hostname) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname);
}

function dohResolve(hostname) {
  if (isIpAddress(hostname)) return Promise.resolve([hostname]);
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    return Promise.resolve(cached.ips);
  }
  return new Promise((resolve, reject) => {
    const p = `/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
    const req = https.get({ hostname: DOH_HOST, port: 443, path: p, headers: DOH_HEADERS, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Status === 0 && json.Answer) {
            const ips = json.Answer.filter(a => a.type === 1).map(a => a.data);
            if (ips.length > 0) { dnsCache.set(hostname, { ips, timestamp: Date.now() }); resolve(ips); return; }
          }
          reject(new Error(`DOH: no A record for ${hostname}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers with DoH resolution + IP fallback
// ---------------------------------------------------------------------------

function httpRequest(method, urlStr, options = {}, redirectDepth = 5) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const timeoutMs = options.timeout || 30000;

  return new Promise((resolve, reject) => {
    dohResolve(u.hostname).then(ips => {
      tryIp(0);
      function tryIp(idx) {
        if (idx >= ips.length) return reject(new Error(`All IPs exhausted for ${u.hostname}`));
        const ip = ips[idx];
        const reqOpts = {
          hostname: ip,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method,
          headers: { ...options.headers, host: u.hostname },
          servername: u.hostname,
          rejectUnauthorized: false,
        };
        const req = mod.request(reqOpts, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectDepth > 0) {
            const redirectUrl = new URL(res.headers.location, urlStr).href;
            res.destroy();
            console.log(`[http] redirect ${res.statusCode} -> ${redirectUrl} (depth=${redirectDepth})`);
            return httpRequest(method, redirectUrl, options, redirectDepth - 1).then(resolve, reject);
          }
          resolve({ req, res, url: urlStr });
        });
        req.on('error', () => tryIp(idx + 1));
        req.setTimeout(timeoutMs, () => { req.destroy(); tryIp(idx + 1); });
        if (options.body) req.write(options.body);
        req.end();
      }
    }).catch(reject);
  });
}

function collectBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// GP balance check for archiver downloads
// ---------------------------------------------------------------------------

// Parse GP cost and balance from E-Hentai archiver page HTML
// Cost format: <strong>X,XXX GP</strong> (org first in DOM, res second)
// Balance format (e-hentai only): Current Funds:</p><p>X,XXX GP
function parseGpInfo(html, dltype) {
  // cost order is always org (left div) then res (right div)
  const allCosts = [...html.matchAll(/Download\s+Cost[^<]*?<strong>([\d,]+)/gi)];
  const idx = dltype === 'org' ? 0 : 1;
  if (!allCosts[idx]) return null;

  const cost = parseInt(allCosts[idx][1].replace(/,/g, ''));
  if (isNaN(cost)) return null;

  // balance: "Current Funds:" then a number + "GP"
  const balMatch = html.match(/Current\s+Funds[^<]*?(?:<[^>]+>)*\s*([\d,]+)\s*GP/i);
  const balance = balMatch ? parseInt(balMatch[1].replace(/,/g, '')) : null;

  return { cost, balance, shortfall: balance !== null ? Math.max(0, cost - balance) : null };
}

// ---------------------------------------------------------------------------
// Archiver flow helpers
// ---------------------------------------------------------------------------

function extractToken(galleryUrl) {
  try {
    const parts = new URL(galleryUrl).pathname.split('/').filter(Boolean);
    return parts[2] || null;
  } catch { return null; }
}

// POST to archiver.php → get H@H archive node URL
// First GETs the page to check GP balance, then POSTs to trigger generation
async function archiverPost(gid, token, dltype, cookies, galleryUrl) {
  const domain = galleryUrl ? new URL(galleryUrl).hostname : 'e-hentai.org';
  const ARCHIVER_URL = `https://${domain}/archiver.php`;
  const fullUrl = `${ARCHIVER_URL}?gid=${gid}&token=${token}`;

  // ── Step A: GET archiver page → check if cached, generating, or needs GP ──
  const { res: getRes } = await httpRequest('GET', fullUrl, {
    headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 15000,
  });

  // Redirect → archive is ready, follow it
  if (getRes.statusCode >= 300 && getRes.statusCode < 400 && getRes.headers.location) {
    console.log(`[dl] archiverPost(${gid}): GET redirected to ${getRes.headers.location}`);
    return getRes.headers.location;
  }

  const getBody = (await collectBody(getRes)).toString('utf8');

  // H@H URL in GET response → archive already cached (GP already paid)
  const cachedMatch = getBody.match(/https?:\/\/[^\s"']*?hath\.network\/archive\/[^\s"']+/);
  if (cachedMatch) {
    console.log(`[dl] archiverPost(${gid}): archive already cached`);
    return cachedMatch[0];
  }

  // Still generating → need to wait
  if (getBody.includes('generating') || getBody.includes('Generating')) {
    console.log(`[dl] archiverPost(${gid}): archive still being generated`);
    throw new Error('Archive is still being generated — try again later');
  }

  // Parse GP cost from primary domain (exhentai shows cost, may not show balance)
  let gpInfo = parseGpInfo(getBody, dltype);
  if (gpInfo) {
    console.log(`[dl] archiverPost(${gid}): primary domain GP cost=${gpInfo.cost}, balance=${gpInfo.balance !== null ? gpInfo.balance : 'not found'}`);

    // If balance is missing on exhentai, try e-hentai.org which does show balance
    if (gpInfo.balance === null && domain === 'exhentai.org') {
      try {
        const eUrl = `https://e-hentai.org/archiver.php?gid=${gid}&token=${token}`;
        const { res: eRes } = await httpRequest('GET', eUrl, {
          headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000,
        });
        if (!(eRes.statusCode >= 300 && eRes.statusCode < 400)) {
          const eBody = (await collectBody(eRes)).toString('utf8');
          const eGp = parseGpInfo(eBody, dltype);
          if (eGp && eGp.balance !== null) {
            gpInfo.balance = eGp.balance;
            gpInfo.shortfall = Math.max(0, gpInfo.cost - eGp.balance);
            console.log(`[dl] archiverPost(${gid}): got balance from e-hentai: ${gpInfo.balance}`);
          }
        }
      } catch (e) {
        console.log(`[dl] archiverPost(${gid}): e-hentai balance check failed: ${e.message}`);
      }
    }

    // Now check with potentially cross-domain balance
    if (gpInfo.balance !== null && gpInfo.balance < gpInfo.cost) {
      throw new Error(
        `Insufficient GP for archive download: need ${gpInfo.cost} GP, ` +
        `have ${gpInfo.balance} GP (shortfall ${gpInfo.shortfall} GP). ` +
        `Download cost may be deducted from other currencies. Top up GP and retry.`
      );
    }
  } else {
    console.log(`[dl] archiverPost(${gid}): could not parse GP info, proceeding`);
  }

  // ── Step B: POST to trigger generation (original logic) ──
  const postBody = new URLSearchParams({
    dltype,
    dlcheck: dltype === 'org' ? 'Download Original Archive' : 'Download Resample Archive',
  }).toString();

  console.log(`[dl] archiverPost: posting to ${fullUrl}`);
  const { res: postRes } = await httpRequest('POST', fullUrl, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(postBody)),
      Cookie: cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: postBody,
  });

  // Follow redirect if present
  if (postRes.statusCode >= 300 && postRes.statusCode < 400 && postRes.headers.location) {
    console.log(`[dl] archiverPost(${gid}): POST redirected to ${postRes.headers.location}`);
    return postRes.headers.location;
  }

  // Parse HTML response
  const body = (await collectBody(postRes)).toString('utf8');
  const snippet = body.slice(0, 300).replace(/\n/g, ' ').trim();
  console.log(`[dl] archiverPost(${gid}): POST status=${postRes.statusCode}, body_len=${body.length}, snippet="${snippet}"`);

  if (body.includes('You must be logged in')) throw new Error('Authentication required — cookies missing or expired');
  if (body.includes('already generating')) {
    console.log(`[dl] archiverPost(${gid}): archive already being generated`);
  }

  // Look for H@H URL
  const match = body.match(/https?:\/\/[^\s"']*?hath\.network\/archive\/[^\s"']+/);
  if (match) { console.log(`[dl] archiverPost(${gid}): found H@H URL`); return match[0]; }

  // Look for general archive URL
  const altMatch = body.match(/https?:\/\/[^\s"']*\/archive\/[^\s"']+/);
  if (altMatch) { console.log(`[dl] archiverPost(${gid}): found alt archive URL`); return altMatch[0]; }

  throw new Error(`Archiver response: status ${postRes.statusCode}, no H@H URL found`);
}

// Access H@H archive node → confirm file is ready, return download URL
// Retries up to 10 times with 30s delay when H@H reports "already being processed"
async function hathAccess(hathUrl, cookies) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const { res } = await httpRequest('GET', hathUrl, {
      headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });

    const body = (await collectBody(res)).toString('utf8');

    // Already ready
    if (body.includes('file ready') || body.includes('download') || res.headers['content-type']?.includes('zip')) {
      console.log(`[dl] hathAccess: file ready on attempt ${attempt}`);
      return hathUrl.includes('?') ? `${hathUrl}&start=1` : `${hathUrl}?start=1`;
    }

    // Still generating (not yet submitted)
    if (body.includes('generating') || body.includes('Generating')) {
      throw new Error('Archive is still being generated — try again later');
    }

    // H@H is processing — common intermediate state, poll with delay
    if (body.includes('already being processed') || body.includes('being processed')) {
      console.log(`[dl] hathAccess(${attempt}): file being processed, waiting 30s...`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    // Check for other H@H redirect
    const match = body.match(/https?:\/\/[^\s"']*?hath\.network\/archive\/[^\s"']+/);
    if (match) return match[0];

    // Unknown response — log a snippet and try with start=1 as fallback
    const snippet = body.slice(0, 200).replace(/\n/g, ' ').trim();
    console.log(`[dl] hathAccess(${attempt}): unknown response, snippet="${snippet}"`);
    return hathUrl.includes('?') ? `${hathUrl}&start=1` : `${hathUrl}?start=1`;
  }

  throw new Error('H@H archive not ready after multiple retries (10 attempts × 30s)');
}

// Fetch gallery page metadata (title, thumbnail) via regex parsing
async function fetchGalleryMetadata(galleryUrl, cookies) {
  const tryFetch = async (url) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    if (cookies) headers['Cookie'] = cookies;
    const { res } = await httpRequest('GET', url, { headers, timeout: 15000 });
    const html = (await collectBody(res)).toString('utf8');
    console.log(`[meta] HTTP ${res.statusCode}, body=${html.length} bytes`);

    // Detect ban/captcha pages
    if (/temporarily banned|excessive request rate|bounce_login|Please wait|captcha/i.test(html.slice(0, 1000))) {
      console.log(`[meta] banned or blocked page for ${url}`);
      return null;
    }

    const titleMatch = html.match(/<h1[^>]*id="gn"[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
    const thumbMatch = html.match(/<div[^>]*id="gd1"[^>]*>[\s\S]*?<div[^>]*style="[^"]*url\(([^)]+)\)/);
    const thumbnailUrl = thumbMatch?.[1] || '';
    console.log(`[meta] title="${title.slice(0,50)}", thumbnail=${thumbnailUrl ? 'yes' : 'no'}, status=${res.statusCode}`);

    return { title, thumbnailUrl, statusCode: res.statusCode };
  };

  try {
    let result = await tryFetch(galleryUrl);

    // Fallback: if original was e-hentai.org and failed, retry with exhentai.org
    if ((!result || result.statusCode >= 400 || !result.title) && galleryUrl.includes('e-hentai.org')) {
      const fallbackUrl = galleryUrl.replace('e-hentai.org', 'exhentai.org');
      console.log(`[meta] e-hentai failed, retrying with exhentai: ${fallbackUrl}`);
      const fallback = await tryFetch(fallbackUrl);
      if (fallback && fallback.title) result = fallback;
    }

    if (!result) return null;
    return { title: result.title || '', thumbnailUrl: result.thumbnailUrl || '' };
  } catch (err) {
    console.log(`[dl] fetchGalleryMetadata error: ${err.message}`);
    return null;
  }
}

// Stream download ZIP file with progress
function downloadZip(downloadUrl, cookies, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const u = new URL(downloadUrl);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    dohResolve(u.hostname).then(ips => {
      tryIp(0);
      function tryIp(idx) {
        if (idx >= ips.length) return reject(new Error(`Download: all IPs exhausted for ${u.hostname}`));
        const ip = ips[idx];
        const opts = {
          hostname: ip, port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          headers: { host: u.hostname, Cookie: cookies, 'User-Agent': 'Mozilla/5.0' },
          servername: u.hostname,
          rejectUnauthorized: false,
        };

        const req = mod.get(opts, (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, downloadUrl).href;
            res.destroy();
            downloadZip(redirectUrl, cookies, outputPath, onProgress).then(resolve, reject);
            return;
          }

          // Ensure output directory exists
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let received = 0;
          const fileStream = fs.createWriteStream(outputPath);

          res.on('data', (chunk) => {
            received += chunk.length;
            const ok = fileStream.write(chunk);
            if (!ok) res.pause(); // backpressure: pause until drain
            if (total > 0) {
              const pct = Math.round((received / total) * 100);
              onProgress(Math.min(pct, 100));
            } else {
              // No content-length, report approximate progress
              onProgress(Math.min(Math.round(received / (1024 * 1024) * 5), 85)); // 5MB = ~1%
            }
          });

          fileStream.on('drain', () => res.resume());

          res.on('end', () => {
            fileStream.end();
            fileStream.on('finish', () => {
              onProgress(100);
              // Validate downloaded file is actually a ZIP
              if (!isZipFile(outputPath)) {
                try {
                  const snippet = fs.readFileSync(outputPath, 'utf8').slice(0, 300);
                  // Extract error message from HTML
                  const errMatch = snippet.match(/<p>([^<]+)<\/p>/);
                  const errMsg = errMatch ? errMatch[1].trim() : snippet.slice(0, 200).replace(/\n/g, ' ');
                  fs.unlinkSync(outputPath);
                  return reject(new Error(`Downloaded file is not a ZIP: ${errMsg}`));
                } catch (e) {
                  return reject(new Error(`Downloaded file is not a valid ZIP archive`));
                }
              }
              resolve();
            });
          });

          res.on('error', (err) => {
            fileStream.destroy();
            reject(err);
          });
        });

        req.on('error', () => tryIp(idx + 1));
        req.setTimeout(60000, () => { req.destroy(); tryIp(idx + 1); });
      }
    }).catch(reject);
  });
}

// Check if file looks like a ZIP via magic bytes (PK\x03\x04)
function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  } catch { return false; }
}

// Read first 512 bytes — useful for error diagnostics
function peekFileContent(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytes = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, bytes);
  } catch { return ''; }
}

// Extract ZIP: use system unzip for large files, fall back to stream-zip
function extractArchive(zipPath, extractDir, gid) {
  return new Promise((resolve, reject) => {
    if (!isZipFile(zipPath)) {
      const snippet = peekFileContent(zipPath);
      // Detect common error pages
      if (snippet.includes('bounce_login') || snippet.includes('login')) {
        return reject(new Error('Authentication required — cookies missing or expired'));
      }
      if (snippet.includes('generating') || snippet.includes('Generating')) {
        return reject(new Error('Archive is still being generated'));
      }
      return reject(new Error(`Downloaded file is not a ZIP (starts with: ${snippet.slice(0, 80).replace(/\n/g, ' ')})`));
    }

    fs.mkdirSync(extractDir, { recursive: true });

    // Try system unzip first (handles large files better, no memory overhead)
    const { execSync } = require('child_process');
    try {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe', timeout: 300000 });
      const files = fs.readdirSync(extractDir).filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f));
      console.log(`[dl] Extracted ${files.length} files via unzip`);
      return resolve(files.length);
    } catch (unzipErr) {
      console.log(`[dl] unzip failed (${unzipErr.message}), falling back to stream-zip`);
    }

    // Fallback: streaming ZIP reader (no 2 GiB limit, low memory)
    extractWithStreamZip(zipPath, extractDir).then(resolve).catch(err => {
      reject(new Error(`Extraction failed: ${err.message}`));
    });
  });
}

// Streaming ZIP extraction using node-stream-zip
function extractWithStreamZip(zipPath, extractDir) {
  return new Promise((resolve, reject) => {
    const zip = new StreamZip({ file: zipPath, storeEntries: true });
    let extracted = 0;

    zip.on('ready', () => {
      const entries = Object.values(zip.entries())
        .filter(e => !e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));

      if (entries.length === 0) {
        zip.close();
        return resolve(0);
      }

      let pending = entries.length;
      let rejected = false;

      for (const entry of entries) {
        const outputFile = path.join(extractDir, path.basename(entry.name));
        zip.stream(entry.name, (err, stream) => {
          if (rejected) return;
          if (err) { rejected = true; zip.close(); return reject(err); }

          const ws = fs.createWriteStream(outputFile);
          ws.on('finish', () => {
            extracted++;
            if (--pending === 0) {
              zip.close();
              resolve(extracted);
            }
          });
          ws.on('error', (wsErr) => {
            rejected = true;
            zip.close();
            reject(wsErr);
          });
          stream.pipe(ws);
        });
      }
    });

    zip.on('error', (err) => {
      reject(err);
    });
  });
}

function cleanupArchive(archivePath, gid) {
  try {
    const archiveDir = path.dirname(archivePath);
    fs.rmSync(archiveDir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

let MAX_CONCURRENT = 2;
const activeJobs = new Map(); // gid → job

function setMaxConcurrent(n) { MAX_CONCURRENT = Math.max(1, Math.min(10, n)); }
let queue = [];

function enqueue(gid, galleryUrl, dltype, cookies) {
  // Check if already completed
  const gallery = store.getGallery(gid);
  if (gallery && gallery.status === 'completed') {
    return { status: 'completed', gid, progress: 100, message: 'Already downloaded' };
  }

  // Check if currently being downloaded
  if (activeJobs.has(gid)) {
    const job = store.getJob(gid);
    return { status: job?.status || 'downloading', gid, progress: job?.progress || 0, message: job?.message || '' };
  }

  // Check if already queued
  if (queue.some(j => j.gid === gid)) {
    return { status: 'queued', gid, progress: 0, message: 'Waiting in queue' };
  }

  // Check if in error state — allow re-queue
  const existingJob = store.getJob(gid);
  if (existingJob && existingJob.status === 'error') {
    store.deleteJob(gid);
  }

  const job = { gid, galleryUrl, dltype: dltype || 'res', cookies: cookies || '', status: 'queued', progress: 0, createdAt: new Date().toISOString() };
  queue.push(job);
  store.setJob(gid, { status: 'queued', progress: 0, galleryUrl, dltype: dltype || 'res', cookies: cookies || '' });

  processQueue();
  return { status: 'queued', gid, progress: 0, message: 'Queued for download' };
}

function processQueue() {
  while (activeJobs.size < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    activeJobs.set(job.gid, job);
    executeJob(job);
  }
}

async function executeJob(job) {
  const { gid, galleryUrl, dltype, cookies, _extractOnly } = job;
  console.log(`[dl] Starting job for gid=${gid}, galleryUrl=${galleryUrl}, extractOnly=${_extractOnly}`);

  let archivePath;

  try {
    if (_extractOnly) {
      // Smart retry: ZIP already downloaded, skip straight to extraction
      archivePath = path.join(CACHE_DIR, 'archives', String(gid), 'archive.zip');
      if (!fs.existsSync(archivePath)) {
        throw new Error('Archive ZIP not found on disk — use full re-download instead');
      }
      console.log(`[dl] ${gid}: archive found at ${archivePath}, skipping to extraction`);
      store.setJob(gid, { status: 'downloading', progress: 85, message: 'Archive found, extracting...' });
    } else {
      // Step 1: Extract token from gallery URL
      const token = extractToken(galleryUrl);
      if (!token) throw new Error(`Could not extract token from ${galleryUrl}`);
      console.log(`[dl] Token: ${token}`);

      // Step 2: Check GP balance + POST to archiver.php → H@H node URL
      store.setJob(gid, { status: 'archiver_access', progress: 5, message: 'Checking GP balance...' });
      let hathUrl = await archiverPost(gid, token, dltype, cookies, galleryUrl);
      console.log(`[dl] H@H URL: ${hathUrl}`);

      // Step 3: Access H@H node → download URL
      store.setJob(gid, { status: 'archiver_access', progress: 10, message: 'Accessing archive node...' });
      const downloadUrl = await hathAccess(hathUrl, cookies);
      console.log(`[dl] Download URL: ${downloadUrl}`);

      // Step 4: Stream download ZIP
      store.setJob(gid, { status: 'downloading', progress: 15, message: 'Downloading archive...' });
      archivePath = path.join(CACHE_DIR, 'archives', String(gid), 'archive.zip');
      await downloadZip(downloadUrl, cookies, archivePath, (pct) => {
        const overall = 15 + Math.floor(pct * 0.70);
        store.setJob(gid, { status: 'downloading', progress: Math.min(overall, 85), message: `Downloading... ${pct}%` });
      });
    }

    // Step 5: Extract ZIP (shared)
    store.setJob(gid, { status: 'extracting', progress: 88, message: 'Extracting archive...' });
    const extractDir = path.join(GALLERIES_DIR, String(gid));
    const fileCount = await extractArchive(archivePath, extractDir, gid);

    // Step 6: Clean up temp
    store.setJob(gid, { status: 'extracting', progress: 98, message: 'Finalizing...' });
    cleanupArchive(archivePath, gid);

    // Step 7: Fetch gallery metadata + thumbnail and save alongside images
    const meta = await fetchGalleryMetadata(galleryUrl, cookies);
    if (meta) {
      try {
        const metaPath = path.join(extractDir, 'metadata.json');
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        if (meta.thumbnailUrl) {
          try {
            const imgHeaders = { 'User-Agent': 'Mozilla/5.0' };
            if (cookies) imgHeaders['Cookie'] = cookies;
            const { res: imgRes } = await httpRequest('GET', meta.thumbnailUrl, {
              headers: imgHeaders, timeout: 15000,
            });
            const imgData = await collectBody(imgRes);
            const thumbExt = path.extname(new URL(meta.thumbnailUrl).pathname) || '.jpg';
            fs.writeFileSync(path.join(extractDir, `cover${thumbExt}`), imgData);
          } catch (err) {
            console.log(`[dl] ${gid}: cover download failed: ${err.message}`);
          }
        }
      } catch (err) {
        console.log(`[dl] ${gid}: metadata save failed: ${err.message}`);
      }
    }

    // Extract gallery path from galleryUrl (e.g. /g/123/token/) for manga URL matching
    let galleryPath = '', galleryDomain = '';
    try { const u = new URL(galleryUrl); galleryPath = u.pathname; galleryDomain = u.hostname; } catch {}

    // Done
    const finalSize = store.getGallerySize(gid);
    store.setGallery(gid, {
      status: 'completed',
      title: meta?.title || '',
      galleryPath,
      galleryDomain,
      totalImages: fileCount,
      size: finalSize,
    });
    store.deleteJob(gid);
    console.log(`[dl] Gallery ${gid} complete — ${fileCount} files${meta?.title ? ', title: ' + meta.title : ''}`);

  } catch (err) {
    console.error(`[dl] Error for gid=${gid}: ${err.message}`);
    store.setJob(gid, { status: 'error', error: err.message });
  } finally {
    activeJobs.delete(gid);
    processQueue();
  }
}

// Smart retry: if archive ZIP exists on disk, skip archiver/download and go straight to extraction
function retryJob(gid) {
  const existingJob = store.getJob(gid);
  if (!existingJob) return { status: 'error', gid, error: 'Job not found' };

  const galleryUrl = existingJob.galleryUrl;
  if (!galleryUrl) return { status: 'error', gid, error: 'No gallery URL for retry' };

  // Check if the H@H session is burned (too many retries from different locations)
  const prevError = (existingJob.error || '').toLowerCase();
  const sessionBurned = prevError.includes('too many different locations');
  if (sessionBurned) {
    // Clean up the invalid archive if present
    const archivePath = path.join(CACHE_DIR, 'archives', String(gid), 'archive.zip');
    try {
      if (fs.existsSync(archivePath)) {
        fs.rmSync(path.dirname(archivePath), { recursive: true, force: true });
      }
    } catch {}

    // Check how long ago the error occurred
    const failedAt = existingJob.updatedAt ? new Date(existingJob.updatedAt).getTime() : 0;
    const elapsed = Date.now() - failedAt;
    const cooldownHours = 4;
    if (elapsed < cooldownHours * 3600000) {
      const remaining = Math.ceil((cooldownHours * 3600000 - elapsed) / 60000);
      store.deleteJob(gid);
      return {
        status: 'error', gid,
        error: `Archive session restricted (too many download attempts). The H@H node has temporarily blocked this archive. ` +
               `Please wait ~${remaining} minutes and retry.`
      };
    }
  }

  const archivePath = path.join(CACHE_DIR, 'archives', String(gid), 'archive.zip');
  // Also verify the archive is actually a ZIP (not an HTML error page saved by mistake)
  let zipExists = fs.existsSync(archivePath);
  if (zipExists) {
    try {
      const fd = fs.openSync(archivePath, 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      zipExists = buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
      if (!zipExists) {
        console.log(`[dl] retryJob(${gid}): existing archive is not a valid ZIP, will re-download`);
        fs.rmSync(archivePath, { force: true });
      }
    } catch {
      zipExists = false;
    }
  }

  // Clear old error state
  store.deleteJob(gid);
  if (activeJobs.has(gid)) activeJobs.delete(gid);
  const qIdx = queue.findIndex(j => j.gid === gid);
  if (qIdx >= 0) queue.splice(qIdx, 1);

  const job = {
    gid, galleryUrl,
    dltype: existingJob.dltype || 'res',
    cookies: existingJob.cookies || '',
    _extractOnly: zipExists,
  };

  queue.push(job);
  store.setJob(gid, {
    status: 'queued', progress: zipExists ? 85 : 0,
    galleryUrl, dltype: existingJob.dltype || 'res',
    cookies: existingJob.cookies || '',
    message: zipExists ? 'Archive found, resuming extraction' : 'Queued for download',
  });

  processQueue();
  return { status: zipExists ? 'extracting' : 'queued', gid, message: zipExists ? 'Archive found, resuming extraction' : 'Queued for download' };
}

// Reload persisted queued jobs on startup (survives container restart)
function initQueue() {
  const jobs = store.listJobs();
  let restored = 0;
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'archiver_access' || job.status === 'extracting') {
      // Reset status to queued so it can be picked up
      if (job.status !== 'queued') {
        store.setJob(job.gid, { status: 'queued', progress: 0, message: 'Restored after restart' });
      }
      queue.push({ gid: job.gid, galleryUrl: job.galleryUrl, dltype: job.dltype || 'res', cookies: job.cookies || '', status: 'queued', progress: 0 });
      restored++;
  }
  }
  // Build default cookies from settings for restored jobs (cookies not persisted)
  const defaultCookies = buildDefaultCookies();
  for (const item of queue) {
    if (!item.cookies) item.cookies = defaultCookies;
  }
  if (restored > 0) {
    const suffix = jobs.length > restored ? ' (out of ' + jobs.length + ' total)' : '';
    console.log('[dl] Restored ' + restored + suffix + ' jobs to queue');
    processQueue();
  }
}

// Call on module load
initQueue();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getStatus(gid) {
  const job = store.getJob(gid);
  const gallery = store.getGallery(gid);
  if (gallery && gallery.status === 'completed') {
    return { status: 'completed', gid, ...gallery };
  }
  if (job) return { status: job.status, gid, progress: job.progress, error: job.error };
  return { status: 'idle', gid };
}

function getQueueInfo() {
  return {
    active: Array.from(activeJobs.keys()).map(gid => ({ gid, status: store.getJob(gid)?.status || 'processing' })),
    queued: queue.map(j => ({ gid: j.gid, status: 'queued' })),
  };
}

module.exports = { enqueue, retryJob, getStatus, getQueueInfo, setMaxConcurrent, fetchGalleryMetadata };
