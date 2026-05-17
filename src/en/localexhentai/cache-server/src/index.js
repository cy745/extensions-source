const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { imageSize } = require('image-size');
const express = require('express');
const store = require('./store');
const downloader = require('./downloader');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'https://e-hentai.org';
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const GALLERIES_DIR = path.join(CACHE_DIR, 'galleries');
const CACHE_FILES_DIR = path.join(CACHE_DIR, 'cache');
const CACHE_TTL_IMAGE_MS = parseInt(process.env.CACHE_TTL_IMAGE_MS || String(7 * 24 * 60 * 60 * 1000), 10); // 7 days
const CACHE_TTL_HTML_MS = parseInt(process.env.CACHE_TTL_HTML_MS || String(60 * 60 * 1000), 10); // 1 hour

// Patch console to include ISO timestamps
['log','warn','error'].forEach(m => {
  const orig = console[m];
  console[m] = (...args) => orig.apply(console, [new Date().toISOString(), ...args]);
});

// Ensure directories exist
[CACHE_DIR, CACHE_FILES_DIR, GALLERIES_DIR, path.join(CACHE_DIR, 'uploads')].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// DNS-over-HTTPS resolver – bypasses network-level DNS poisoning
// ---------------------------------------------------------------------------
const DOH_HOST = '104.16.133.229'; // hardcoded Cloudflare DNS IP
const DOH_HEADERS = { 'accept': 'application/dns-json', 'host': 'cloudflare-dns.com' };
const dnsCache = new Map();
const DNS_CACHE_TTL = 300_000; // 5 minutes

function isIpAddress(hostname) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname);
}

function dohResolve(hostname) {
  // If it's already an IP, return it as single-element array
  if (isIpAddress(hostname)) return Promise.resolve([hostname]);

  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    return Promise.resolve(cached.ips);
  }
  return new Promise((resolve, reject) => {
    const path = `/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
    const req = https.get({ hostname: DOH_HOST, port: 443, path, headers: DOH_HEADERS, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Status === 0 && json.Answer) {
            const ips = json.Answer.filter(a => a.type === 1).map(a => a.data);
            if (ips.length > 0) {
              dnsCache.set(hostname, { ips, timestamp: Date.now() });
              resolve(ips);
              return;
            }
          }
          reject(new Error(`DOH: no A record for ${hostname}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Pre-resolve common upstream hostnames at startup
function warmupDns() {
  const hosts = [...new Set(['e-hentai.org', 'exhentai.org', ...(UPSTREAM_HOST ? [new URL(UPSTREAM_HOST).hostname] : [])])];
  hosts.forEach(host => {
    dohResolve(host).then(ips => console.log(`[dns] ${host} -> ${ips.join(', ')}`)).catch(err => console.error(`[dns] ${host} failed: ${err.message}`));
  });
}

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

function getCacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.\w+$/);
    return match ? match[0] : '';
  } catch { return ''; }
}

function extFromContentType(ct) {
  if (!ct) return '';
  const map = { 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/avif': '.avif', 'text/html': '.html', 'application/json': '.json' };
  return map[ct] || '';
}

function getCacheDataPath(key, ext) { return path.join(CACHE_FILES_DIR, `${key}${ext || '.data'}`); }
function getCacheMetaPath(key) { return path.join(CACHE_FILES_DIR, `${key}.json`); }

function getCached(url) {
  const key = getCacheKey(url);
  const metaPath = getCacheMetaPath(key);
  const meta = readMeta(metaPath);
  if (!meta) return null;
  const ext = extFromUrl(url) || extFromContentType(meta.contentType);
  const dataPath = getCacheDataPath(key, ext || '.data');
  if (!fs.existsSync(dataPath)) return null;
  try {
    const ttl = meta.ttl || CACHE_TTL_IMAGE_MS;
    const expired = Date.now() - meta.timestamp > ttl;
    const data = fs.readFileSync(dataPath);
    return { meta, data, expired };
  } catch {
    return null;
  }
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch { return null; }
}

function setCache(url, statusCode, headers, data) {
  const key = getCacheKey(url);
  const ct = getContentType(headers) || '';
  const ext = extFromUrl(url) || extFromContentType(ct);
  const ttl = cacheTtlFor(ct);
  const meta = { url, statusCode, headers, contentType: ct, ttl, timestamp: Date.now() };
  try {
    fs.writeFileSync(getCacheMetaPath(key), JSON.stringify(meta));
    fs.writeFileSync(getCacheDataPath(key, ext), data);
  } catch (err) {
    console.error(`[cache] write error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

function buildOriginalUrl(upstream, reqPath, reqQuery) {
  const base = upstream.replace(/\/+$/, '');
  const qs = reqQuery ? `?${reqQuery}` : '';
  return `${base}${reqPath}${qs}`;
}

const HATH_RE = /hath\.network$/i;

function proxyRequest(originalUrl, method, headers, retries, redirectDepth = 5) {
  const u = new URL(originalUrl);
  const isHath = HATH_RE.test(u.hostname);
  if (retries === undefined) retries = isHath ? 0 : 1;
  const timeoutMs = isHath ? 5000 : 8000;

  return new Promise((resolve, reject) => {
    const proxy = (u.protocol === 'https:' ? https : http);

    // Forward relevant headers, strip host-specific ones and connection headers
    const forwardHeaders = { ...headers };
    delete forwardHeaders.host;
    delete forwardHeaders['x-original-host'];
    delete forwardHeaders['transfer-encoding'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['content-length'];
    // Keep cookies, user-agent, accept, etc. – the extension sends them

    // Resolve hostname via DOH, then try IPs one by one
    dohResolve(u.hostname).then((ips) => {
      tryIp(0);

      function tryIp(idx) {
        if (idx >= ips.length) {
          if (retries > 0) {
            console.log(`[RETRY] all IPs failed for ${u.hostname}, ${retries} retries left`);
            setTimeout(() => {
              dohResolve(u.hostname).then(() => {
                proxyRequest(originalUrl, method, headers, retries - 1, redirectDepth).then(resolve, reject);
              }).catch(reject);
            }, 1000);
          } else {
            reject(new Error(`All IPs exhausted for ${u.hostname}`));
          }
          return;
        }

        const resolvedIp = ips[idx];
        const ac = new AbortController();
        let done = false;

        const options = {
          hostname: resolvedIp,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method,
          headers: { ...forwardHeaders, host: u.hostname },
          servername: u.hostname, // TLS SNI
          rejectUnauthorized: false,
          signal: ac.signal,
        };

        const req = proxy.request(options, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);

          // Follow redirects (301, 302, 307, 308)
          const status = res.statusCode;
          if ([301, 302, 307, 308].includes(status) && redirectDepth > 0) {
            const location = res.headers['location'];
            if (location) {
              const redirectUrl = new URL(location, originalUrl).href;
              console.log(`[REDIRECT] ${status} -> ${redirectUrl} (${redirectDepth} left)`);
              res.destroy();
              proxyRequest(redirectUrl, 'GET', headers, retries, redirectDepth - 1).then(resolve, reject);
              return;
            }
          }

          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: status,
              headers: res.headers,
              data: Buffer.concat(chunks),
            });
          });
        });

        req.on('error', (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);

          const recoverable = ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)
            || err.name === 'AbortError'
            || err.message.includes('disconnected before secure TLS');
          if (recoverable) {
            console.log(`[IPFAIL] ${resolvedIp} for ${u.hostname} → ${err.code || err.name}, trying next (${idx + 1}/${ips.length})`);
            tryIp(idx + 1);
          } else {
            reject(err);
          }
        });

        const timer = setTimeout(() => {
          if (done) return;
          ac.abort();
          console.log(`[TMOUT] ${timeoutMs}ms for ${u.hostname} (${resolvedIp}), trying next (${idx + 1}/${ips.length})`);
          tryIp(idx + 1);
        }, timeoutMs);

        req.end();
      }
    }).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Cache-control helpers – decide what is cacheable
// ---------------------------------------------------------------------------

function cacheTtlFor(contentType) {
  if (!contentType) return CACHE_TTL_IMAGE_MS;
  if (contentType.startsWith('image/')) return CACHE_TTL_IMAGE_MS;
  if (contentType.startsWith('text/html')) return CACHE_TTL_HTML_MS;
  return CACHE_TTL_IMAGE_MS;
}

function shouldCache(url, statusCode, contentType) {
  if (statusCode !== 200) return false;
  if (contentType && (contentType.startsWith('image/') || contentType.startsWith('text/html'))) return true;
  return false;
}

// Detect known error pages (ban, captcha, etc.) so we don't cache them
function isErrorPage(data, contentType, contentEncoding) {
  if (!contentType || !contentType.startsWith('text/html') || !data || data.length < 50) return false;
  try {
    let raw = data;
    if (contentEncoding && contentEncoding.includes('gzip')) raw = zlib.gunzipSync(data);
    if (contentEncoding && contentEncoding.includes('deflate')) raw = zlib.inflateSync(data);
    const snippet = raw.toString('utf8').slice(0, 500);
    return /temporarily banned|excessive request rate|IP banned|please wait|bounce_login|captcha/i.test(snippet);
  } catch { return false; }
}

function getContentType(headers) {
  const ct = headers['content-type'];
  return Array.isArray(ct) ? ct[0] : ct;
}

// ---------------------------------------------------------------------------
// Express app — Dashboard + Management API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
const multer = require('multer');
const upload = multer({ dest: path.join(CACHE_DIR, 'uploads'), limits: { fileSize: 5000 * 1024 * 1024 } });

// Serve React build (production)
const REACT_DIST = path.join(__dirname, '../web/dist');
if (fs.existsSync(REACT_DIST)) {
  app.use(express.static(REACT_DIST));
}

// Dashboard data API
app.get('/api/dashboard', (req, res) => {
  const jobs = store.listJobs();
  const galleries = store.listGalleries();
  const queued = jobs
    .filter(j => ['queued', 'downloading', 'archiver_access', 'extracting'].includes(j.status))
    .map(j => ({ gid: j.gid, status: j.status, progress: j.progress || 0, message: j.message || '' }));

  const completedAll = galleries
    .filter(g => g.status === 'completed')
    .map(g => ({
      gid: g.gid,
      title: g.title || '',
      totalImages: store.getGalleryImageCount(g.gid),
      size: store.getGallerySize(g.gid),
      downloadedAt: g.updatedAt,
    }));

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(5, parseInt(req.query.perPage) || 20));
  const total = completedAll.length;
  const start = (page - 1) * perPage;
  const completed = completedAll.slice(start, start + perPage);

  const failed = jobs
    .filter(j => j.status === 'error')
    .map(j => ({ gid: j.gid, error: j.error || 'Unknown', galleryUrl: j.galleryUrl || '', dltype: j.dltype || 'res', failedAt: j.updatedAt }));

  const disk = store.getDiskUsage();

  res.json({ queued, completed, total, page, perPage, hasNext: start + perPage < total, failed, system: { diskUsed: disk.used, diskFree: disk.free } });
});

// ── Settings persistence ──
const SETTINGS_PATH = path.join(CACHE_DIR, 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch {}
}

// Apply maxConcurrent from settings to downloader
function applyMaxConcurrent(settings) {
  if (settings.maxConcurrent) downloader.setMaxConcurrent(settings.maxConcurrent);
}

// Settings API
app.get('/api/settings', (req, res) => res.json(loadSettings()));
app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  const current = loadSettings();
  if (body.ipb_member_id !== undefined) current.ipb_member_id = body.ipb_member_id;
  if (body.ipb_pass_hash !== undefined) current.ipb_pass_hash = body.ipb_pass_hash;
  if (body.igneous !== undefined) current.igneous = body.igneous;
  if (body.maxConcurrent !== undefined) current.maxConcurrent = Math.max(1, Math.min(10, parseInt(body.maxConcurrent) || 2));
  applyMaxConcurrent(current);
  saveSettings(current);
  res.json({ success: true });
});

// Apply on startup
applyMaxConcurrent(loadSettings());

// Build cookie string from settings
function buildDefaultCookies() {
  const s = loadSettings();
  const parts = [];
  if (s.ipb_member_id) parts.push(`ipb_member_id=${s.ipb_member_id}`);
  if (s.ipb_pass_hash) parts.push(`ipb_pass_hash=${s.ipb_pass_hash}`);
  if (s.igneous) parts.push(`igneous=${s.igneous}`);
  return parts.join('; ');
}

// Download trigger — merges client cookies with server defaults
app.post('/api/download', (req, res) => {
  const { gid, galleryUrl, dltype } = req.body || {};
  if (!gid || !galleryUrl) return res.status(400).json({ error: 'gid and galleryUrl required' });
  const clientCookies = req.headers.cookie || '';
  const defaultCookies = buildDefaultCookies();
  // Merge: client cookies override defaults
  const cookies = clientCookies ? clientCookies + '; ' + defaultCookies : defaultCookies;
  const result = downloader.enqueue(gid, galleryUrl, dltype || 'res', cookies);
  res.json(result);
});

// Download status
app.get('/api/status', (req, res) => {
  const gid = req.query.gid;
  if (!gid) return res.status(400).json({ error: 'gid required' });
  res.json(downloader.getStatus(gid));
});

// Browse gallery (check if downloaded)
app.get('/api/browse', (req, res) => {
  const gid = req.query.gid;
  if (!gid) return res.status(400).json({ error: 'gid required' });

  const gallery = store.getGallery(gid);
  if (!gallery || gallery.status !== 'completed') {
    const job = store.getJob(gid);
    if (job && ['queued', 'downloading', 'archiver_access', 'extracting'].includes(job.status)) {
      return res.json({ status: 'not_ready', message: `Download in progress: ${job.status}` });
    }
    return res.json({ status: 'not_ready', message: 'Gallery not downloaded yet' });
  }

  const dir = path.join(GALLERIES_DIR, String(gid));
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f) && !f.startsWith('cover.'))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
        const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
        return na - nb;
      })
      .map(f => `/api/galleries/${gid}/${f}`);
  } catch {}

  res.json({
    status: 'ready',
    gid: Number(gid),
    title: gallery.title || '',
    totalImages: files.length,
    images: files,
  });
});

// Serve gallery files
app.get('/api/galleries/:gid/:filename', (req, res) => {
  const filePath = path.join(GALLERIES_DIR, req.params.gid, req.params.filename);
  // Prevent path traversal
  if (filePath.indexOf(GALLERIES_DIR) !== 0) return res.status(403).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// Delete gallery
app.post('/api/delete', (req, res) => {
  const gid = req.query.gid;
  if (!gid) return res.status(400).json({ error: 'gid required' });
  store.deleteGallery(gid);
  store.deleteJob(gid);
  res.json({ status: 'deleted', gid });
  console.log(`[api] Deleted gallery ${gid}`);
});

// Refresh metadata + cover for a gallery
app.post('/api/refresh-metadata', async (req, res) => {
  const { gid } = req.body || {};
  if (!gid) return res.status(400).json({ error: 'gid required' });
  console.log(`[meta] refresh requested for gid=${gid}`);
  try {
    const gallery = store.getGallery(gid);
    if (!gallery || gallery.status !== 'completed') return res.status(400).json({ error: 'Gallery not completed' });
    const extractDir = path.join(GALLERIES_DIR, String(gid));
    const domain = gallery.galleryDomain || 'exhentai.org';
    const galleryUrl = gallery.galleryUrl || `https://${domain}${gallery.galleryPath || '/g/' + gid + '/?nw=always'}`;
    console.log(`[meta] fetching metadata from ${galleryUrl}`);
    const defaultCookies = buildDefaultCookies();
    const meta = await downloader.fetchGalleryMetadata(galleryUrl, defaultCookies);
    if (meta) {
      console.log(`[meta] got title="${meta.title?.slice(0,50)}", thumbnail=${meta.thumbnailUrl ? 'yes' : 'no'}`);
      const metaPath = path.join(extractDir, 'metadata.json');
      try { fs.mkdirSync(extractDir, { recursive: true }); } catch {}
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      if (meta.title) {
        store.setGallery(gid, { title: meta.title });
        console.log(`[meta] saved title for gid=${gid}`);
      }
      if (meta.thumbnailUrl) {
        try {
          console.log(`[meta] downloading cover from ${meta.thumbnailUrl}`);
          const imgHeaders = { 'User-Agent': 'Mozilla/5.0' };
          if (defaultCookies) imgHeaders['Cookie'] = defaultCookies;
          const imgResult = await proxyRequest(meta.thumbnailUrl, 'GET', imgHeaders, 1);
          const imgData = imgResult?.data;
          if (imgData) {
            const thumbExt = path.extname(new URL(meta.thumbnailUrl).pathname) || '.jpg';
            fs.writeFileSync(path.join(extractDir, 'cover' + thumbExt), imgData);
            console.log(`[meta] cover saved (${imgData.length} bytes) for gid=${gid}`);
          } else {
            console.log(`[meta] cover response empty for gid=${gid}`);
          }
        } catch (err) {
          console.log(`[meta] cover download failed for ${gid}: ${err.message}`);
        }
      } else {
        console.log(`[meta] no thumbnail URL for gid=${gid}`);
      }
      res.json({ success: true, title: meta.title || '', thumbnailUrl: meta.thumbnailUrl || '' });
    } else {
      console.log(`[meta] fetchGalleryMetadata returned null for gid=${gid}`);
      res.json({ success: false, error: 'Failed to fetch metadata' });
    }
  } catch (err) {
    console.error(`[meta] error for gid=${gid}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Import a ZIP file + gallery URL (manual import)
app.post('/api/import', upload.single('file'), async (req, res) => {
  const galleryUrl = req.body?.url || '';
  const file = req.file;
  if (!galleryUrl) return res.status(400).json({ error: 'galleryUrl required' });
  if (!file) return res.status(400).json({ error: 'ZIP file required' });

  const match = galleryUrl.match(/https?:\/\/(?:e-hentai|exhentai)\.org\/g\/(\d+)\/([^\/]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid gallery URL format' });
  const gid = match[1];

  console.log(`[import] gid=${gid}, url=${galleryUrl}, file=${file.originalname} (${file.size} bytes)`);

  try {
    // Check if already downloaded
    const existing = store.getGallery(gid);
    if (existing && existing.status === 'completed') {
      try { fs.unlinkSync(file.path); } catch {}
      return res.json({ status: 'already_exists', gid, message: 'Gallery already imported' });
    }

    const extractDir = path.join(GALLERIES_DIR, String(gid));
    const archiveDir = path.join(CACHE_DIR, 'archives', String(gid));
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // Move uploaded file to archives
    const archivePath = path.join(archiveDir, 'archive.zip');
    fs.renameSync(file.path, archivePath);

    // Extract
    const { execSync } = require('child_process');
    try {
      execSync(`unzip -o "${archivePath}" -d "${extractDir}"`, { stdio: 'pipe', timeout: 300000 });
    } catch {
      // Fallback to adm-zip
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const basename = path.basename(entry.entryName);
          fs.writeFileSync(path.join(extractDir, basename), entry.getData());
        }
      }
    }

    const fileCount = fs.readdirSync(extractDir).filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f)).length;
    console.log(`[import] ${gid}: extracted ${fileCount} files`);

    // Fetch metadata + cover
    const defaultCookies = buildDefaultCookies();
    const meta = await downloader.fetchGalleryMetadata(galleryUrl, defaultCookies);
    if (meta) {
      fs.writeFileSync(path.join(extractDir, 'metadata.json'), JSON.stringify(meta, null, 2));
      if (meta.thumbnailUrl) {
        try {
          const imgHeaders = { 'User-Agent': 'Mozilla/5.0' };
          if (defaultCookies) imgHeaders['Cookie'] = defaultCookies;
          const imgResult = await proxyRequest(meta.thumbnailUrl, 'GET', imgHeaders, 1);
          if (imgResult?.data) {
            const thumbExt = path.extname(new URL(meta.thumbnailUrl).pathname) || '.jpg';
            fs.writeFileSync(path.join(extractDir, 'cover' + thumbExt), imgResult.data);
          }
        } catch (err) {
          console.log(`[import] ${gid}: cover failed: ${err.message}`);
        }
      }
    }

    // Clean up archive
    try { fs.rmSync(archiveDir, { recursive: true, force: true }); } catch {}

    // Save gallery record
    let galleryPath = '';
    try { galleryPath = new URL(galleryUrl).pathname; } catch {}
    const galleryDomain = new URL(galleryUrl).hostname;
    const finalSize = store.getGallerySize(gid);
    store.setGallery(gid, {
      status: 'completed', title: meta?.title || '', galleryPath, galleryDomain,
      totalImages: fileCount, size: finalSize,
    });
    store.deleteJob(gid);
    console.log(`[import] ${gid}: import complete (${fileCount} files)`);
    res.json({ status: 'imported', gid, title: meta?.title || '', totalImages: fileCount });
  } catch (err) {
    console.error(`[import] ${gid}: error: ${err.message}`);
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// List downloaded galleries (paginated, newest first)
app.get('/api/downloaded', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = 20;
  const all = store.listGalleries().filter(g => g.status === 'completed');
  const total = all.length;
  const start = (page - 1) * perPage;
  const paged = all.slice(start, start + perPage);
  res.json({
    list: paged.map(g => ({
      gid: g.gid,
      title: g.title || '',
      url: (g.galleryPath || `/g/${g.gid}/`) + '?nw=always',
      totalImages: g.totalImages || 0,
      downloadedAt: g.updatedAt,
    })),
    total,
    hasNext: start + perPage < total,
    page,
  });
});

// Gallery waterfall API — flat paginated list of all images across all galleries
app.get('/api/gallery-images', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(120, Math.max(1, parseInt(req.query.perPage || '60', 10)));
  const galleries = store.listGalleries().filter(g => g.status === 'completed');

  const allImages = [];
  for (const g of galleries) {
    const dir = path.join(GALLERIES_DIR, String(g.gid));
    try {
      const files = fs.readdirSync(dir)
        .filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f) && !f.startsWith('cover.'))
        .sort((a, b) => {
          const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
          const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
          return na - nb;
        });
      for (const f of files) {
        allImages.push({
          gid: g.gid,
          title: g.title || '',
          url: `/api/galleries/${g.gid}/${f}`,
        });
      }
    } catch {}
  }

  const total = allImages.length;
  const start = (page - 1) * perPage;
  const images = allImages.slice(start, start + perPage);

  res.json({ images, total, page, perPage, hasNext: start + perPage < total });
});

// Gallery overview — each gallery with first image + cover
app.get('/api/gallery-overview', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.perPage || '24', 10)));
  const galleries = store.listGalleries().filter(g => g.status === 'completed');

  const result = [];
  for (const g of galleries) {
    const dir = path.join(GALLERIES_DIR, String(g.gid));
    try {
      const files = fs.readdirSync(dir)
        .filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f))
        .sort((a, b) => {
          const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
          const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
          return na - nb;
        });
      const cover = files.find(f => f.startsWith('cover.')) || '';
      const firstImage = files.find(f => !f.startsWith('cover.')) || '';
      const imageFiles = files.filter(f => !f.startsWith('cover.'));
      result.push({
        gid: g.gid,
        title: g.title || '',
        firstImageUrl: firstImage ? `/api/galleries/${g.gid}/${firstImage}` : '',
        coverUrl: cover ? `/api/galleries/${g.gid}/${cover}` : '',
        totalImages: imageFiles.length,
      });
    } catch {}
  }

  const total = result.length;
  const start = (page - 1) * perPage;
  const list = result.slice(start, start + perPage);

  res.json({ list, total, page, perPage, hasNext: start + perPage < total });
});

// Gallery detail — paginated images for a specific gallery
app.get('/api/gallery-detail/:gid', (req, res) => {
  const gid = req.params.gid;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(120, Math.max(1, parseInt(req.query.perPage || '60', 10)));

  const gallery = store.getGallery(gid);
  if (!gallery || gallery.status !== 'completed') {
    return res.status(404).json({ error: 'Gallery not found' });
  }

  const dir = path.join(GALLERIES_DIR, String(gid));
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f) && !f.startsWith('cover.'))
      .sort((a, b) => {
        const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
        const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
        return na - nb;
      });
  } catch {}

  const total = files.length;
  const start = (page - 1) * perPage;
  const images = files.slice(start, start + perPage).map(f => {
    let w = 0, h = 0;
    try {
      const dim = imageSize(fs.readFileSync(path.join(dir, f)));
      w = dim.width; h = dim.height;
    } catch {}
    return { url: `/api/galleries/${gid}/${f}`, w, h };
  });

  // Find cover
  let coverUrl = '';
  try {
    const allFiles = fs.readdirSync(dir).filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f));
    const cover = allFiles.find(f => f.startsWith('cover.'));
    if (cover) coverUrl = `/api/galleries/${gid}/${cover}`;
  } catch {}

  res.json({
    images, total, page, perPage,
    hasNext: start + perPage < total,
    title: gallery.title || '',
    gid,
    coverUrl,
  });
});

// SPA fallback — all non-API, non-proxy routes serve the React app
if (fs.existsSync(REACT_DIST)) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) return next();
    res.sendFile(path.join(REACT_DIST, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Proxy route — handles all /proxy/* requests by forwarding to upstream
// ---------------------------------------------------------------------------

app.all('/proxy/{*path}', async (req, res) => {
  const startTime = Date.now();
  const method = req.method || 'GET';
  // path-to-regexp v8 returns repeating params as array — join with /
  const rawPath = Array.isArray(req.params.path) ? req.params.path.join('/') : (req.params.path || '');
  const upstreamPath = rawPath ? '/' + rawPath : '/';
  const reqQuery = req.url.includes('?') ? req.url.split('?')[1] : '';

  // Determine upstream from X-Original-Host, else default
  let originalHost = req.headers['x-original-host'] || UPSTREAM_HOST;
  const serverHost = req.headers['host'] || '';
  if (originalHost === serverHost || originalHost === '192.168.3.116' || originalHost === '127.0.0.1' || originalHost === 'localhost') {
    if (originalHost !== UPSTREAM_HOST) console.log(`[FIX] X-Original-Host was '${originalHost}', falling back to '${UPSTREAM_HOST}'`);
    originalHost = UPSTREAM_HOST;
  }
  const upstream = originalHost.startsWith('http') ? originalHost : `https://${originalHost}`;
  const originalUrl = buildOriginalUrl(upstream, upstreamPath, reqQuery);

  console.log(`[REQ] ${method} ${req.url} -> ${originalUrl}`);

  // Check cache (stale-while-revalidate: expired entries are still served on error)
  const cached = getCached(originalUrl);
  if (cached && !cached.expired) {
    const elapsed = Date.now() - startTime;
    console.log(`[HIT ] ${method} ${originalUrl} (${elapsed}ms)`);
    res.writeHead(cached.meta.statusCode, {
      ...cached.meta.headers,
      'x-cache': 'HIT',
      'x-cache-timestamp': new Date(cached.meta.timestamp).toISOString(),
    });
    res.end(cached.data);
    return;
  }

  // Proxy to upstream
  try {
    const proxyRes = await proxyRequest(originalUrl, method, req.headers);
    const elapsed = Date.now() - startTime;

    const ct = getContentType(proxyRes.headers);
    if (shouldCache(originalUrl, proxyRes.statusCode, ct)) {
      // Don't cache known error/ban pages
      const ce = Array.isArray(proxyRes.headers['content-encoding'])
        ? proxyRes.headers['content-encoding'].join(', ') : proxyRes.headers['content-encoding'];
      if (isErrorPage(proxyRes.data, ct, ce)) {
        console.log(`[BAN] ${method} ${proxyRes.statusCode} ${originalUrl} (${elapsed}ms) [ban detected, not cached]`);
      } else {
        setCache(originalUrl, proxyRes.statusCode, proxyRes.headers, proxyRes.data);
        console.log(`[${cached ? 'STALE' : 'MISS'}] ${method} ${proxyRes.statusCode} ${originalUrl} (${elapsed}ms) [cached]`);
      }
    } else {
      console.log(`[PAS] ${method} ${proxyRes.statusCode} ${originalUrl} (${elapsed}ms)`);
    }

    const responseHeaders = {
      ...proxyRes.headers,
      'x-cache': proxyRes.statusCode === 200 && shouldCache(originalUrl, proxyRes.statusCode, ct) ? (cached ? 'STALE' : 'MISS') : 'BYPASS',
    };
    delete responseHeaders['transfer-encoding'];

    res.writeHead(proxyRes.statusCode, responseHeaders);
    res.end(proxyRes.data);
  } catch (err) {
    // If we have expired cache, serve it as fallback
    if (cached && cached.expired) {
      console.log(`[STALE] ${method} ${originalUrl} — upstream error, serving stale cache`);
      res.writeHead(cached.meta.statusCode, {
        ...cached.meta.headers,
        'x-cache': 'STALE',
        'x-cache-timestamp': new Date(cached.meta.timestamp).toISOString(),
      });
      res.end(cached.data);
      return;
    }
    const elapsed = Date.now() - startTime;
    console.error(`[ERR] ${method} ${originalUrl} (${elapsed}ms): ${err.message}`);
    const errBody = JSON.stringify({
      originalUrl,
      message: err.message,
    });
    res.writeHead(502, { 'content-type': 'application/json', 'x-cache': 'ERROR' });
    res.end(errBody);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ehentai-cache-server] listening on port ${PORT}`);
  console.log(`[ehentai-cache-server] upstream: ${UPSTREAM_HOST}`);
  console.log(`[ehentai-cache-server] cache dir: ${CACHE_DIR}`);
  console.log(`[ehentai-cache-server] cache TTL: image=${CACHE_TTL_IMAGE_MS}ms html=${CACHE_TTL_HTML_MS}ms`);
  warmupDns();
});
