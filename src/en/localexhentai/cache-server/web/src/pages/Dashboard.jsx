import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import ThemeBtn from '../components/ThemeBtn';

function fmtSize(b) {
  if (!b) return '—';
  const mb = b / 1024 / 1024;
  return mb >= 1024 ? `(${(mb / 1024).toFixed(1)} GiB)` : `(${mb.toFixed(0)} MiB)`;
}

function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 10) return 'just now';
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

/* ── GalleryCard ── */
function GalleryCard({ g, onDelete, onRefreshMeta }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const needsMeta = imgFailed || !g.title;
  const size = g.size ? `(${(g.size / 1024 / 1024).toFixed(0)} MiB)` : '';

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefreshMeta(g.gid);
    setRefreshing(false);
  };

  return (
    <div className="gallery-card">
      <div className="gallery-thumb-wrap">
        {imgFailed ? (
          <div className="thumb-placeholder">▣</div>
        ) : (
          <img className="gallery-thumb" src={`/api/galleries/${g.gid}/cover.webp`} alt="" loading="lazy" onError={() => setImgFailed(true)} />
        )}
      </div>
      <div className="gallery-info">
        <div className="gallery-title">{g.title || 'Untitled'}</div>
        <div className="gallery-meta">
          <span>#{g.gid}</span>
          <span>{g.totalImages || '?'} pages</span>
          <span>{size || '—'}</span>
          <span>{relTime(g.downloadedAt)}</span>
        </div>
        <div className="gallery-actions">
          <a className="btn" href={`/gallery/${g.gid}`}>Browse</a>
          {needsMeta && (
            <button className="btn btn-refreshmeta" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? '…' : '↻'}
            </button>
          )}
          <button className="btn btn-delete" onClick={() => onDelete(g.gid)}>Delete</button>
        </div>
      </div>
    </div>
  );
}

/* ── Paginator ── */
function Paginator({ page, perPage, total, onPage, onPerPage }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const pages = [];
  let prev = 0;
  for (const p of [1, page - 2, page - 1, page, page + 1, page + 2, totalPages]) {
    if (p < 1 || p > totalPages || p <= prev) continue;
    if (prev && p - prev > 1) pages.push('…');
    pages.push(p);
    prev = p;
  }

  return (
    <div className="paginator">
      <div className="paginator-info">{total} galleries · Page {page} of {totalPages}</div>
      <div className="paginator-controls">
        <select value={perPage} onChange={e => onPerPage(parseInt(e.target.value))} className="paginator-select">
          <option value={12}>12 / page</option>
          <option value={24}>24 / page</option>
          <option value={36}>36 / page</option>
          <option value={48}>48 / page</option>
        </select>
        <button className="paginator-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
        {pages.map((p, i) =>
          p === '…' ? <span key={`e${i}`} className="paginator-dots">…</span> : (
            <button key={p} className={`paginator-btn${p === page ? ' active' : ''}`} onClick={() => onPage(p)}>{p}</button>
          )
        )}
        <button className="paginator-btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
      </div>
    </div>
  );
}

/* ── Dashboard ── */
export default function Dashboard() {

  // Data
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(12);

  // Modals
  const [dlUrl, setDlUrl] = useState('');
  const [dlResult, setDlResult] = useState(null);
  const [dlLoading, setDlLoading] = useState(false);
  const [showDl, setShowDl] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ ipb_member_id: '', ipb_pass_hash: '', igneous: '', maxConcurrent: 2 });
  const [settingsLoading, setSettingsLoading] = useState(false);

  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importLoading, setImportLoading] = useState(false);

  // Intercept browser back to close modals instead of navigating
  const modalRef = useRef(false);
  useEffect(() => {
    const onPop = () => {
      if (modalRef.current) {
        modalRef.current = false;
        setShowDl(false);
        setDlResult(null);
        setShowSettings(false);
        setShowImport(false);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Track modal open/close to auto-cleanup history entry
  const prevAnyModal = useRef(false);
  useEffect(() => {
    const anyOpen = showDl || !!dlResult || showSettings || showImport;
    if (prevAnyModal.current && !anyOpen && modalRef.current) {
      modalRef.current = false;
      history.back();
    }
    prevAnyModal.current = anyOpen;
  }, [showDl, dlResult, showSettings, showImport]);

  // Activity log
  const [logSort, setLogSort] = useState('time-desc');
  const [selectedLog, setSelectedLog] = useState(new Set());
  const sortedFailed = useMemo(() => {
    if (!data?.failed) return [];
    const items = [...data.failed];
    switch (logSort) {
      case 'time-asc': items.sort((a, b) => new Date(a.failedAt || 0) - new Date(b.failedAt || 0)); break;
      case 'gid-asc': items.sort((a, b) => parseInt(a.gid) - parseInt(b.gid)); break;
      case 'gid-desc': items.sort((a, b) => parseInt(b.gid) - parseInt(a.gid)); break;
      default: items.sort((a, b) => new Date(b.failedAt || 0) - new Date(a.failedAt || 0)); break;
    }
    return items;
  }, [data?.failed, logSort]);

  const batchRetry = async () => {
    const items = data?.failed?.filter(j => selectedLog.has(j.gid)) || [];
    if (!items.length) return;
    setSelectedLog(new Set());
    const urls = items.filter(j => j.galleryUrl).map(j => j.galleryUrl).join('\n');
    if (urls) { showDlModal(urls); }
  };
  const batchDelete = async () => {
    const items = data?.failed?.filter(j => selectedLog.has(j.gid)) || [];
    if (!items.length) return;
    for (const j of items) {
      try { await api.clearJob(j.gid); } catch {}
    }
    toast('Cleared ' + items.length + ' entries');
    setSelectedLog(new Set());
    load();
  };

  // Refresh tick
  const [tick, setTick] = useState(0);
  const lastRefresh = useRef(Date.now());

  const load = useCallback(async () => {
    try {
      const d = await api.getDashboard(page, perPage);
      setData(d);
      lastRefresh.current = Date.now();
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [page, perPage]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id); }, []);

  // Load settings
  useEffect(() => {
    api.getSettings().then(d => {
      if (d && typeof d === 'object')
        setSettings({ ipb_member_id: d.ipb_member_id || '', ipb_pass_hash: d.ipb_pass_hash || '', igneous: d.igneous || '', maxConcurrent: d.maxConcurrent || 2 });
    }).catch(() => {});
  }, []);

  // Modal body lock
  useEffect(() => {
    const open = showDl || dlResult || showSettings || showImport;
    document.body.style.overflow = open ? 'hidden' : '';
    document.body.style.paddingRight = open ? (window.innerWidth - document.documentElement.clientWidth) + 'px' : '';
    return () => { document.body.style.overflow = ''; document.body.style.paddingRight = ''; };
  }, [showDl, dlResult, showSettings, showImport]);

  const handleDelete = useCallback(async (gid) => {
    if (!window.confirm(`Delete Gallery #${gid}? Remove gallery files and history. This cannot be undone.`)) return;
    try {
      await api.deleteGallery(gid);
      toast('Deleted #' + gid);
      load();
    } catch (e) { toast('Delete failed: ' + e.message); }
  }, [load]);

  const handleRefreshMeta = useCallback(async (gid) => {
    try {
      const d = await api.refreshMetadata(gid);
      if (d.success) { load(); toast('Metadata refreshed'); }
      else toast('Refresh failed: ' + (d.error || 'unknown'));
    } catch (e) { toast('Network error: ' + e.message); }
  }, [load]);

  const showDlModal = (url) => {
    setDlUrl(typeof url === 'string' ? url : '');
    setDlResult(null);
    modalRef.current = true;
    setShowDl(true);
    history.pushState(null, '');
  };

  const startDl = async () => {
    const text = dlUrl.trim();
    if (!text) return;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const urls = [];
    for (const line of lines) {
      const match = line.match(/https?:\/\/(?:e-hentai|exhentai)\.org\/g\/(\d+)\/([^\/]+)/);
      if (match) urls.push({ gid: match[1], galleryUrl: line.replace(/\/?(\?.*)?$/, '/') });
    }
    if (urls.length === 0) {
      modalRef.current = true;
      setDlResult({ success: false, title: 'No Valid URLs', msg: 'No valid E-Hentai gallery URLs found in input.' });
      history.pushState(null, '');
      return;
    }
    setDlLoading(true);
    const results = [];
    for (const { gid, galleryUrl } of urls) {
      try {
        const r = await api.downloadGallery(gid, galleryUrl);
        const s = r.status || 'error';
        const p = r.progress ?? 0;
        const e = r.error || '';
        const m = r.message || '';
        let msg;
        if (s === 'completed') msg = '✅ #' + gid + ' already downloaded';
        else if (s === 'downloading') msg = '⬇ #' + gid + ' downloading (' + p + '%)' + (m ? ' ' + m : '');
        else if (s === 'queued') msg = '⏳ #' + gid + ' queued';
        else if (s === 'archiver_access' || s === 'extracting') msg = '🔄 #' + gid + ' ' + s + (m ? ' ' + m : '');
        else if (s === 'error') msg = '❌ #' + gid + ' ' + (e || 'failed');
        else msg = '#' + gid + ': ' + s;
        results.push(msg);
      } catch (e) {
        results.push('❌ #' + gid + ' network error');
      }
    }
    setDlLoading(false);
    setShowDl(false);
    const successCount = results.filter(r => r.startsWith('✅') || r.startsWith('⏳') || r.startsWith('⬇') || r.startsWith('🔄')).length;
    modalRef.current = true;
    setDlResult({ success: successCount > 0, title: successCount + '/' + urls.length + ' submitted', msg: results.join('\n') });
    history.pushState(null, '');
    load();
  };

  const handleSaveSettings = async () => {
    setSettingsLoading(true);
    try {
      await api.saveSettings(settings);
      setShowSettings(false);
      toast('Settings saved');
    } catch (e) { toast('Save failed: ' + e.message); }
    setSettingsLoading(false);
  };

  const handleImport = async () => {
    if (!importUrl.trim() || !importFile) { toast('Provide a gallery URL and ZIP file'); return; }
    setImportLoading(true);
    try {
      const d = await api.importZip(importUrl.trim(), importFile);
      if (d.status === 'imported' || d.status === 'already_exists') {
        toast('Imported #' + d.gid + (d.title ? ': ' + d.title : ''));
        setShowImport(false);
        setImportUrl('');
        setImportFile(null);
        load();
      } else {
        toast('Import failed: ' + (d.error || 'unknown'));
      }
    } catch (e) { toast('Error: ' + e.message); }
    setImportLoading(false);
  };

  const retryDl = (gid, galleryUrl) => {
    if (!galleryUrl) { toast('No gallery URL for retry'); return; }
    showDlModal(galleryUrl);
  };

  const closeOverlay = setter => e => { if (e.target.classList.contains('modal-overlay')) setter(false); };

  if (error) {
    return (
      <div className="app">
        <header className="header">
          <h1>Cache Server</h1>
          <div className="header-actions">
            <button className="refresh-btn" onClick={load}>↻ RETRY</button>
            <ThemeBtn />
          </div>
        </header>
        <div className="empty">
          <div className="empty-icon">⚠</div>
          <div className="empty-text">Failed to connect: {error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <header className="header"><h1>Cache Server</h1></header>
        <div className="loading">
          <div><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
        </div>
      </div>
    );
  }

  const { queued, completed, failed, system, total } = data;
  const diskFree = system?.diskFree || 0;
  const diskUsed = system?.diskUsed || 0;

  return (
    <div className="app">
      <header className="header">
        <h1>Cache Server</h1>
        <div className="header-actions">
          <button className="refresh-btn" onClick={() => showDlModal()}>
            <span className="btn-label-wide">+ DOWNLOAD</span>
            <span className="btn-label-narrow">+</span>
          </button>
          <button className="theme-btn" onClick={() => { modalRef.current = true; setShowImport(true); history.pushState(null, ''); }} title="Import ZIP">📦</button>
          <button className="refresh-btn refresh-btn--with-time" onClick={load}>
            <span className="btn-label-wide">↻ REFRESH</span>
            <span className="btn-label-narrow">↻</span>
            <span className="refresh-time"> · {relTime(lastRefresh.current)}</span>
          </button>
          <div className="header-divider" />
          <ThemeBtn />
          <button className="theme-btn" onClick={() => { modalRef.current = true; setShowSettings(true); history.pushState(null, ''); }} title="Settings">⚙</button>
        </div>
      </header>

      {/* Metrics */}
      <div className="metrics">
        <div className="metric active"><div className="metric-value">{queued.length}</div><div className="metric-label">Active</div></div>
        <div className="metric downloaded"><div className="metric-value">{total || 0}</div><div className="metric-label">Downloaded</div></div>
        <div className="metric failed"><div className="metric-value">{failed?.length || 0}</div><div className="metric-label">Failed</div></div>
        <div className="metric">
          <div className="metric-value">{diskUsed > 0 ? fmtSize(diskUsed) : '—'}</div>
          <div className="metric-label">Storage</div>
          <div className="metric-sub">{diskFree > 0 ? fmtSize(diskFree) + ' free' : '—'}</div>
        </div>
      </div>

      {/* Active Downloads */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Active Downloads</span>
          {queued.length > 0 && <span className="section-count">{queued.length} task{queued.length !== 1 ? 's' : ''}</span>}
        </div>
        {queued.length === 0 ? (
          <div className="empty"><div className="empty-icon">○</div><div className="empty-text">No active downloads</div></div>
        ) : (
          <div className="jobs">
            {queued.map(j => {
              const cls = ({ downloading: 'downloading', extracting: 'extracting', queued: 'queued', archiver_access: 'archiver_access' })[j.status] || '';
              return (
                <div className="job" key={j.gid}>
                  <div className="job-meta">
                    <span className="job-gid">#{j.gid}</span>
                    <span className={`job-status ${cls}`}>{j.status}</span>
                  </div>
                  {j.message && <div className="job-message">{j.message}</div>}
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: (j.progress || 0) + '%' }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Gallery Library */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Gallery Library</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {total > 0 && <span className="section-count">{total} Galleries</span>}
            <a className="btn" href="/gallery" style={{ fontSize: '.65rem' }}>Gallery View →</a>
          </div>
        </div>
        {completed?.length > 0 && (
          <div className="search-wrap">
            <input type="text" placeholder="Search by GID or title…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}
        {completed?.length === 0 ? (
          <div className="empty"><div className="empty-icon">○</div><div className="empty-text">No galleries downloaded yet</div></div>
        ) : (
          <>
            <div className="gallery-grid">
              {completed.filter(g => {
                if (!search) return true;
                const q = search.toLowerCase();
                return String(g.gid).includes(q) || (g.title || '').toLowerCase().includes(q);
              }).map(g => (
                <GalleryCard key={g.gid} g={g} onDelete={handleDelete} onRefreshMeta={handleRefreshMeta} />
              ))}
            </div>
            {total > perPage && (
              <Paginator page={page} perPage={perPage} total={total} onPage={setPage} onPerPage={n => { setPerPage(n); setPage(1); }} />
            )}
          </>
        )}
      </div>

      {/* Activity Log */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Activity Log</span>
          {failed?.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="section-count">{failed.length} failure{failed.length !== 1 ? 's' : ''}</span>
              <select className="sort-select" value={logSort} onChange={e => setLogSort(e.target.value)}>
                <option value="time-desc">Newest first</option>
                <option value="time-asc">Oldest first</option>
                <option value="gid-asc">GID ↑</option>
                <option value="gid-desc">GID ↓</option>
              </select>
            </div>
          )}
        </div>
        {failed?.length > 0 && (
          <div className="batch-actions">
            <label className="log-cb-wrap" title="Select all">
              <input type="checkbox" className="log-cb all-cb"
                checked={selectedLog.size === failed.length && failed.length > 0}
                ref={el => { if (el) el.indeterminate = selectedLog.size > 0 && selectedLog.size < failed.length; }}
                onChange={e => setSelectedLog(e.target.checked ? new Set(failed.map(j => j.gid)) : new Set())} />
              <span className="log-cb-mark" />
            </label>
            <span className="batch-count">{selectedLog.size}</span>
            <div className="batch-divider" />
            <button className={`btn${selectedLog.size > 0 ? '' : ' disabled'}`} onClick={batchRetry}
              disabled={selectedLog.size === 0}>↻ Retry All</button>
            <button className={`btn${selectedLog.size > 0 ? '' : ' disabled'}`} onClick={batchDelete}
              disabled={selectedLog.size === 0}>Delete</button>
          </div>
        )}
        {!failed?.length ? (
          <div className="empty"><div className="empty-icon">○</div><div className="empty-text">No failures</div></div>
        ) : (
          <div className="log">
            {sortedFailed.map(j => (
              <div className={`log-entry${selectedLog.has(j.gid) ? ' selected' : ''}`} key={j.gid + (j.failedAt || '')}>
                <label className="log-cb-wrap">
                  <input type="checkbox" className="log-cb"
                    checked={selectedLog.has(j.gid)}
                    onChange={e => { const s = new Set(selectedLog); e.target.checked ? s.add(j.gid) : s.delete(j.gid); setSelectedLog(s); }} />
                  <span className="log-cb-mark" />
                </label>
                <span className="log-time">{j.failedAt ? new Date(j.failedAt).toLocaleString() : ''}</span>
                <a className="log-gid" href={j.galleryUrl || `https://exhentai.org/g/${j.gid}/`} target="_blank" rel="noreferrer">#{j.gid}</a>
                <span className="log-msg error" style={{ flex: 1 }}>{j.error || 'Unknown'}</span>
                <button className="btn btn-sm" onClick={() => retryDl(j.gid, j.galleryUrl)}>↻ Retry</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast */}
      <div className="toast" id="toast" />

      {/* Quick Download Modal */}
      <div className={`modal-overlay ${showDl ? 'active' : ''}`} onClick={closeOverlay(() => { setShowDl(false); setDlResult(null); })}>
        <div className="modal">
          <h3>Quick Download</h3>
          <p>Paste E-Hentai or ExHentai gallery URLs (one per line):</p>
          <textarea
            className="dl-textarea"
            value={dlUrl}
            onChange={e => setDlUrl(e.target.value)}
            placeholder="https://e-hentai.org/g/3939724/5d11cabac4/&#10;https://exhentai.org/g/3939725/6ef2ce74a8/"
            disabled={dlLoading}
            rows={Math.max(3, (dlUrl || '').split('\n').length)}
          />
          {dlLoading && <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginTop: 8 }}>Processing…</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => { setShowDl(false); setDlUrl(''); setDlResult(null); }} disabled={dlLoading}>Cancel</button>
            <button className="btn btn-primary" onClick={startDl} disabled={dlLoading || !dlUrl.trim()}>Start Download</button>
          </div>
        </div>
      </div>

      {/* Download Result Modal */}
      <div className={`modal-overlay ${dlResult ? 'active' : ''}`} onClick={closeOverlay(() => setDlResult(null))}>
        <div className="modal">
          <h3>{dlResult?.success ? '✅' : '❌'} {dlResult?.title || ''}</h3>
          <p style={{ whiteSpace: 'pre-wrap', fontSize: '.8rem', lineHeight: 1.6, maxHeight: 300, overflowY: 'auto' }}>{dlResult?.msg || ''}</p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setDlResult(null)}>OK</button>
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      <div className={`modal-overlay ${showSettings ? 'active' : ''}`} onClick={closeOverlay(() => setShowSettings(false))}>
        <div className="modal">
          <h3>⚙ Default Credentials</h3>
          <p style={{ fontSize: '.8rem', marginBottom: 16 }}>These values are used when the client doesn&apos;t send its own cookies. Client values take priority.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>ipb_member_id</label>
            <input className="dl-input" value={settings.ipb_member_id} onChange={e => setSettings(s => ({...s, ipb_member_id: e.target.value}))} placeholder="e.g. 1234567" disabled={settingsLoading} />
            <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 4 }}>ipb_pass_hash</label>
            <input className="dl-input" value={settings.ipb_pass_hash} onChange={e => setSettings(s => ({...s, ipb_pass_hash: e.target.value}))} placeholder="e.g. abcdef1234567890abcdef1234567890" disabled={settingsLoading} type="password" />
            <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 4 }}>igneous</label>
            <input className="dl-input" value={settings.igneous} onChange={e => setSettings(s => ({...s, igneous: e.target.value}))} placeholder="e.g. abcdef123" disabled={settingsLoading} />
            <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 12 }}>Concurrent Downloads</label>
            <div className="conc-control">
              <button className="conc-btn" onClick={() => setSettings(s => ({...s, maxConcurrent: Math.max(1, s.maxConcurrent - 1)}))} disabled={settingsLoading || settings.maxConcurrent <= 1}>−</button>
              <span className="conc-value">{settings.maxConcurrent}</span>
              <button className="conc-btn" onClick={() => setSettings(s => ({...s, maxConcurrent: Math.min(10, s.maxConcurrent + 1)}))} disabled={settingsLoading || settings.maxConcurrent >= 10}>+</button>
            </div>
          </div>
          {settingsLoading && <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginTop: 12 }}>Saving…</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => setShowSettings(false)} disabled={settingsLoading}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveSettings} disabled={settingsLoading}>Save</button>
          </div>
        </div>
      </div>

      {/* Import Modal */}
      <div className={`modal-overlay ${showImport ? 'active' : ''}`} onClick={closeOverlay(() => { setShowImport(false); setImportFile(null); setImportUrl(''); })}>
        <div className="modal">
          <h3>📦 Import ZIP</h3>
          <p>Select a ZIP file of images and provide the gallery URL for metadata.</p>
          <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 8, display: 'block' }}>Gallery URL</label>
          <input className="dl-input" value={importUrl} onChange={e => setImportUrl(e.target.value)} placeholder="https://exhentai.org/g/3939724/5d11cabac4/" disabled={importLoading} />
          <label style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 12, display: 'block' }}>ZIP File</label>
          <div className="file-dropzone" onClick={e => e.currentTarget.querySelector('input').click()}>
            <input type="file" accept=".zip" hidden onChange={e => setImportFile(e.target.files[0])} />
            {importFile ? <span style={{ fontSize: '.8rem', color: 'var(--text)' }}>{importFile.name}</span> : <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>Click to select ZIP file</span>}
          </div>
          {importLoading && <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginTop: 8 }}>Importing…</p>}
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => { setShowImport(false); setImportFile(null); setImportUrl(''); }} disabled={importLoading}>Cancel</button>
            <button className="btn btn-primary" onClick={handleImport} disabled={importLoading || !importUrl.trim() || !importFile}>Import</button>
          </div>
        </div>
      </div>
    </div>
  );
}
