const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.CACHE_DIR || '/app/cache';
const JOBS_DIR = path.join(BASE_DIR, 'jobs');
const GALLERIES_DIR = path.join(BASE_DIR, 'galleries');

// Ensure directories exist
[JOBS_DIR, GALLERIES_DIR].forEach(d => {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Job persistence — tracks download progress per gallery
// ---------------------------------------------------------------------------

function jobPath(gid) { return path.join(JOBS_DIR, `${gid}.json`); }

function getJob(gid) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(gid), 'utf8'));
  } catch { return null; }
}

function setJob(gid, data) {
  const existing = getJob(gid) || {};
  const merged = { ...existing, ...data, gid, updatedAt: new Date().toISOString() };
  // Preserve createdAt
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  try {
    fs.writeFileSync(jobPath(gid), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error(`[store] write job ${gid} error: ${err.message}`);
  }
  return merged;
}

function deleteJob(gid) {
  try { fs.unlinkSync(jobPath(gid)); } catch {}
}

function listJobs() {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Gallery persistence — tracks extracted galleries
// ---------------------------------------------------------------------------

function galleryStatusPath(gid) { return path.join(GALLERIES_DIR, String(gid), 'status.json'); }

function getGallery(gid) {
  try {
    return JSON.parse(fs.readFileSync(galleryStatusPath(gid), 'utf8'));
  } catch { return null; }
}

function setGallery(gid, data) {
  const dir = path.join(GALLERIES_DIR, String(gid));
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const existing = getGallery(gid) || {};
  const merged = { ...existing, ...data, gid, updatedAt: new Date().toISOString() };
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  try {
    fs.writeFileSync(galleryStatusPath(gid), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error(`[store] write gallery ${gid} error: ${err.message}`);
  }
  return merged;
}

function listGalleries() {
  try {
    return fs.readdirSync(GALLERIES_DIR)
      .filter(f => /^\d+$/.test(f)) // only numeric dirs (gid)
      .map(gid => getGallery(gid))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  } catch { return []; }
}

function getGalleryImageCount(gid) {
  const dir = path.join(GALLERIES_DIR, String(gid));
  try {
    return fs.readdirSync(dir).filter(f => /\.(webp|jpg|jpeg|png|gif|avif)$/i.test(f)).length;
  } catch { return 0; }
}

function getGallerySize(gid) {
  const dir = path.join(GALLERIES_DIR, String(gid));
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return total;
}

function deleteGallery(gid) {
  const dir = path.join(GALLERIES_DIR, String(gid));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

function getDiskUsage() {
  try {
    const { execSync } = require('child_process');
    const out = String(execSync(`df -B1 ${BASE_DIR} 2>/dev/null || echo "unavailable"`));
    const parts = out.trim().split('\n').pop().split(/\s+/);
    if (parts.length >= 4) {
      return { total: parts[1], used: parts[2], free: parts[3], available: parts[3] };
    }
  } catch {}
  // Fallback: rough estimate from galleries dir
  try {
    let used = 0;
    for (const f of fs.readdirSync(GALLERIES_DIR)) {
      const p = path.join(GALLERIES_DIR, f);
      try { used += fs.statSync(p).size; } catch {}
      try { for (const sf of fs.readdirSync(p)) { try { used += fs.statSync(path.join(p, sf)).size; } catch {} } } catch {}
    }
    return { total: 'N/A', used: String(used), free: 'N/A', available: 'N/A' };
  } catch {
    return { total: 'N/A', used: 'N/A', free: 'N/A', available: 'N/A' };
  }
}

module.exports = {
  getJob, setJob, deleteJob, listJobs,
  getGallery, setGallery, listGalleries,
  getGalleryImageCount, getGallerySize, deleteGallery,
  getDiskUsage,
};
