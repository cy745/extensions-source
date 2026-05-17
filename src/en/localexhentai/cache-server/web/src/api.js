const API_BASE = '/api';

async function fetchJSON(url, options) {
  const r = await fetch(API_BASE + url, options);
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export function getDashboard(page = 1, perPage = 12) {
  return fetchJSON(`/dashboard?page=${page}&perPage=${perPage}`);
}

export function getSettings() {
  return fetchJSON('/settings');
}

export function saveSettings(data) {
  return fetchJSON('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function downloadGallery(gid, galleryUrl) {
  return fetchJSON('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gid, galleryUrl, dltype: 'res' }),
  });
}

export function deleteGallery(gid) {
  return fetchJSON('/delete?gid=' + gid, { method: 'POST' });
}

export function refreshMetadata(gid) {
  return fetchJSON('/refresh-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gid }),
  });
}

export function importZip(url, file) {
  const form = new FormData();
  form.append('url', url);
  form.append('file', file);
  return fetch(API_BASE + '/import', { method: 'POST', body: form }).then(r => r.json());
}

export function getGalleryOverview(page = 1, perPage = 24) {
  return fetchJSON(`/gallery-overview?page=${page}&perPage=${perPage}`);
}

export function getGalleryDetail(gid, page = 1, perPage = 60) {
  return fetchJSON(`/gallery-detail/${gid}?page=${page}&perPage=${perPage}`);
}

export function getDownloadStatus(gid) {
  return fetchJSON(`/status?gid=${gid}`);
}
