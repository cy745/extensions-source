const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const express = require('express');
const store = require('./store');
const downloader = require('./downloader');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'https://e-hentai.org';
const CACHE_DIR = process.env.CACHE_DIR || '/app/cache';
const GALLERIES_DIR = path.join(CACHE_DIR, 'galleries');
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10); // 7 days default

// Patch console to include ISO timestamps
['log','warn','error'].forEach(m => {
  const orig = console[m];
  console[m] = (...args) => orig.apply(console, [new Date().toISOString(), ...args]);
});

// Ensure cache directory exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

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

function getCacheDataPath(key, ext) { return path.join(CACHE_DIR, `${key}${ext || '.data'}`); }
function getCacheMetaPath(key) { return path.join(CACHE_DIR, `${key}.json`); }

function getCached(url) {
  const key = getCacheKey(url);
  const metaPath = getCacheMetaPath(key);
  const meta = readMeta(metaPath);
  if (!meta) return null;
  const ext = extFromUrl(url) || extFromContentType(meta.contentType);
  // Try extension-based path first, fall back to legacy .data
  const dataPath = getCacheDataPath(key, ext);
  const legacyPath = getCacheDataPath(key, '.data');
  const actualPath = fs.existsSync(dataPath) ? dataPath : (fs.existsSync(legacyPath) ? legacyPath : null);
  if (!actualPath) return null;
  try {
    if (Date.now() - meta.timestamp > CACHE_TTL_MS) {
      fs.unlinkSync(metaPath);
      fs.unlinkSync(legacyPath);
      try { fs.unlinkSync(dataPath); } catch {}
      return null;
    }
    return { meta, data: fs.readFileSync(actualPath) };
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
  const meta = { url, statusCode, headers, contentType: ct, timestamp: Date.now() };
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

function parseUpstreamHost(raw) {
  const u = raw.startsWith('http') ? new URL(raw) : new URL(`https://${raw}`);
  return { hostname: u.hostname, port: u.port || '443', protocol: u.protocol };
}

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

function shouldCache(url, statusCode, contentType) {
  if (statusCode !== 200) return false;
  // Only cache gallery pages, image pages, API-style requests
  if (contentType && (contentType.startsWith('text/html') || contentType.startsWith('image/'))) return true;
  return false;
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

// Dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Dashboard data API
app.get('/api/dashboard', (req, res) => {
  const jobs = store.listJobs();
  const galleries = store.listGalleries();
  const queueInfo = downloader.getQueueInfo();

  const queued = jobs
    .filter(j => ['queued', 'downloading', 'archiver_access', 'extracting'].includes(j.status))
    .map(j => ({ gid: j.gid, status: j.status, progress: j.progress || 0, message: j.message || '' }));

  const completed = galleries
    .filter(g => g.status === 'completed')
    .map(g => ({
      gid: g.gid,
      title: g.title || '',
      totalImages: store.getGalleryImageCount(g.gid),
      size: store.getGallerySize(g.gid),
      downloadedAt: g.updatedAt,
    }));

  const failed = jobs
    .filter(j => j.status === 'error')
    .map(j => ({ gid: j.gid, error: j.error || 'Unknown', failedAt: j.updatedAt }));

  const disk = store.getDiskUsage();

  res.json({ queued, completed, failed, system: { diskUsed: disk.used, diskFree: disk.free } });
});

// Download trigger — passes client cookies to the archiver flow
app.post('/api/download', (req, res) => {
  const { gid, galleryUrl, dltype } = req.body || {};
  if (!gid || !galleryUrl) return res.status(400).json({ error: 'gid and galleryUrl required' });
  const cookies = req.headers.cookie || '';
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
      .filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f))
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

  // Check cache
  const cached = getCached(originalUrl);
  if (cached) {
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
      setCache(originalUrl, proxyRes.statusCode, proxyRes.headers, proxyRes.data);
      console.log(`[MISS] ${method} ${proxyRes.statusCode} ${originalUrl} (${elapsed}ms) [cached]`);
    } else {
      console.log(`[PAS] ${method} ${proxyRes.statusCode} ${originalUrl} (${elapsed}ms)`);
    }

    const responseHeaders = {
      ...proxyRes.headers,
      'x-cache': proxyRes.statusCode === 200 && shouldCache(originalUrl, proxyRes.statusCode, ct) ? 'MISS' : 'BYPASS',
    };
    delete responseHeaders['transfer-encoding'];

    res.writeHead(proxyRes.statusCode, responseHeaders);
    res.end(proxyRes.data);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[ERR] ${method} ${originalUrl} (${elapsed}ms): ${err.message}`);
    const errBody = JSON.stringify({
      error: 'Cache miss and upstream unreachable',
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
  console.log(`[ehentai-cache-server] cache TTL: ${CACHE_TTL_MS}ms`);
  warmupDns();
});
