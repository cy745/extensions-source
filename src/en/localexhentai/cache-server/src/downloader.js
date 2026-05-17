const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const AdmZip = require('adm-zip');
const store = require('./store');

const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const GALLERIES_DIR = path.join(CACHE_DIR, 'galleries');

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
// Archiver flow helpers
// ---------------------------------------------------------------------------

function extractToken(galleryUrl) {
  try {
    const parts = new URL(galleryUrl).pathname.split('/').filter(Boolean);
    return parts[2] || null;
  } catch { return null; }
}

// POST to archiver.php → get H@H archive node URL
async function archiverPost(gid, token, dltype, cookies, galleryUrl) {
  // Use the same domain as the gallery URL (supports e-hentai.org and exhentai.org)
  const domain = galleryUrl ? new URL(galleryUrl).hostname : 'e-hentai.org';
  const ARCHIVER_URL = `https://${domain}/archiver.php`;
  const postBody = new URLSearchParams({
    dltype,
    dlcheck: dltype === 'org' ? 'Download Original Archive' : 'Download Resample Archive',
  }).toString();

  console.log(`[dl] archiverPost: posting to ${ARCHIVER_URL}?gid=${gid}&token=${token}`);
  const { res } = await httpRequest('POST', `${ARCHIVER_URL}?gid=${gid}&token=${token}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(postBody)),
      Cookie: cookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: postBody,
  });

  // Follow redirect if present
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    return res.headers.location;
  }

  // Otherwise parse HTML for H@H URL
  const body = (await collectBody(res)).toString('utf8');

  // Log response details for debugging
  const snippet = body.slice(0, 300).replace(/\n/g, ' ').trim();
  console.log(`[dl] archiverPost(${gid}): status=${res.statusCode}, body_len=${body.length}, snippet="${snippet}"`);

  // Check for error messages
  if (body.includes('You must be logged in')) throw new Error('Authentication required — cookies missing or expired');
  if (body.includes('already generating')) {
    console.log(`[dl] archiverPost(${gid}): archive still being generated`);
  }

  // Look for H@H URL pattern
  const match = body.match(/https?:\/\/[^\s"']*?hath\.network\/archive\/[^\s"']+/);
  if (match) { console.log(`[dl] archiverPost(${gid}): found H@H URL`); return match[0]; }

  // Look for general archive URL
  const altMatch = body.match(/https?:\/\/[^\s"']*\/archive\/[^\s"']+/);
  if (altMatch) { console.log(`[dl] archiverPost(${gid}): found alt archive URL`); return altMatch[0]; }

  throw new Error(`Archiver response: status ${res.statusCode}, no H@H URL found`);
}

// Access H@H archive node → confirm file is ready, return download URL
async function hathAccess(hathUrl, cookies) {
  const { res } = await httpRequest('GET', hathUrl, {
    headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });

  const body = (await collectBody(res)).toString('utf8');

  if (body.includes('file ready') || body.includes('download') || res.headers['content-type']?.includes('zip')) {
    // Already ready — download URL is the same + ?start=1
    return hathUrl.includes('?') ? `${hathUrl}&start=1` : `${hathUrl}?start=1`;
  }

  if (body.includes('generating') || body.includes('Generating')) {
    // Archive still being generated, keep polling
    throw new Error('Archive is still being generated — try again later');
  }

  // Check for other H@H redirect
  const match = body.match(/https?:\/\/[^\s"']*?hath\.network\/archive\/[^\s"']+/);
  if (match) return match[0];

  // Default: try with start=1 anyway
  return hathUrl.includes('?') ? `${hathUrl}&start=1` : `${hathUrl}?start=1`;
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

// Extract ZIP: use system unzip for large files, fall back to adm-zip
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

    // Try system unzip first (handles large files better)
    const { execSync } = require('child_process');
    try {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe', timeout: 300000 });
      const files = fs.readdirSync(extractDir).filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f));
      console.log(`[dl] Extracted ${files.length} files via unzip`);
      return resolve(files.length);
    } catch (unzipErr) {
      // If unzip not available or fails, fall back to adm-zip
      console.log(`[dl] unzip failed (${unzipErr.message}), falling back to adm-zip`);
    }

    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      entries.sort((a, b) => a.entryName.localeCompare(b.entryName));

      let extracted = 0;
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const basename = path.basename(entry.entryName);
          const outputFile = path.join(extractDir, basename);
          const data = entry.getData();
          fs.writeFileSync(outputFile, data);
          extracted++;
        }
      }
      console.log(`[dl] Extracted ${extracted} files via adm-zip`);
      resolve(extracted);
    } catch (err) {
      reject(new Error(`Extraction failed: ${err.message}`));
    }
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
  store.setJob(gid, { status: 'queued', progress: 0, galleryUrl, dltype: dltype || 'res' });

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
  const { gid, galleryUrl, dltype, cookies } = job;
  console.log(`[dl] Starting archiver flow for gid=${gid}, galleryUrl=${galleryUrl}, dltype=${dltype}`);

  try {
    // Step 1: Extract token from gallery URL
    const token = extractToken(galleryUrl);
    if (!token) throw new Error(`Could not extract token from ${galleryUrl}`);
    console.log(`[dl] Token: ${token}`);

    // Step 2: POST to archiver.php → H@H node URL
    store.setJob(gid, { status: 'archiver_access', progress: 5, message: 'Contacting archiver...' });
    let hathUrl = await archiverPost(gid, token, dltype, cookies, galleryUrl);
    console.log(`[dl] H@H URL: ${hathUrl}`);

    // Step 3: Access H@H node → download URL
    store.setJob(gid, { status: 'archiver_access', progress: 10, message: 'Accessing archive node...' });
    const downloadUrl = await hathAccess(hathUrl, cookies);
    console.log(`[dl] Download URL: ${downloadUrl}`);

    // Step 4: Stream download ZIP
    store.setJob(gid, { status: 'downloading', progress: 15, message: 'Downloading archive...' });
    const archivePath = path.join(CACHE_DIR, 'archives', String(gid), 'archive.zip');
    await downloadZip(downloadUrl, cookies, archivePath, (pct) => {
      const overall = 15 + Math.floor(pct * 0.70);
      store.setJob(gid, { status: 'downloading', progress: Math.min(overall, 85), message: `Downloading... ${pct}%` });
    });

    // Step 5: Extract ZIP
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

module.exports = { enqueue, getStatus, getQueueInfo, setMaxConcurrent, fetchGalleryMetadata };
