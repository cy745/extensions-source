import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getGalleryDetail } from '../api';
import Lightbox from '../components/Lightbox';
import AutoScroll from '../components/AutoScroll';
import ThemeBtn from '../components/ThemeBtn';
import screenfull from 'screenfull';

// Module-level cache — survives unmount/remount across route changes
const previewCache = {};
let savedScrollY = 0;

export default function RandomPreview() {
  const { seed } = useParams();
  const nav = useNavigate();

  const cache = previewCache[seed];

  const [images, setImages] = useState(cache?.images || []);
  const [total, setTotal] = useState(cache?.total || 0);
  const [hasNext, setHasNext] = useState(cache?.hasNext ?? true);
  const [loaded, setLoaded] = useState(!!cache);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [lbIndex, setLbIndex] = useState(-1);
  const lbRef = useRef(false);
  const lbIdxRef = useRef(0);

  // Intercept browser back to close lightbox instead of navigating
  useEffect(() => {
    const onPop = () => {
      if (lbRef.current) {
        const idx = lbIdxRef.current;
        setLbIndex(-1);
        lbRef.current = false;
        setTimeout(() => {
          const el = document.querySelector(`[data-global="${idx}"]`);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            setTimeout(() => {
              el.classList.add('focus-flash');
              setTimeout(() => el.classList.remove('focus-flash'), 3000);
            }, 500);
          }
        }, 100);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [isFs, setIsFs] = useState(() => screenfull.isFullscreen);
  const fsRestoreIdx = useRef(-1);
  const saveCenter = () => {
    const items = document.querySelectorAll('[data-global]');
    if (!items.length) return;
    const ch = window.innerHeight / 2;
    let best = -1, bestDist = Infinity;
    items.forEach(el => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - ch);
      if (d < bestDist) { bestDist = d; best = parseInt(el.dataset.global); }
    });
    fsRestoreIdx.current = best;
  };
  const setFs = (val) => { saveCenter(); setIsFs(val); };
  useEffect(() => {
    if (fsRestoreIdx.current < 0) return;
    const idx = fsRestoreIdx.current;
    fsRestoreIdx.current = -1;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-global="${idx}"]`);
      if (el) el.scrollIntoView({ block: 'center' });
    });
  }, [isFs]);
  useEffect(() => {
    const onChange = () => setFs(screenfull.isFullscreen);
    screenfull.on('change', onChange);
    const onResize = () => {
      if (!screenfull.isFullscreen) {
        const likelyFs = window.innerHeight >= screen.height - 50 && Math.abs(window.innerWidth - screen.width) < 50;
        setFs(likelyFs);
      }
    };
    window.addEventListener('resize', onResize);
    return () => { screenfull.off('change', onChange); window.removeEventListener('resize', onResize); };
  }, []);
  const toggleFs = () => { saveCenter(); if (screenfull.isEnabled) screenfull.toggle(); };

  const pageRef = useRef(cache?.page || 1);
  const sentinelRef = useRef(null);

  // Restore scroll position when returning from gallery detail
  useEffect(() => {
    if (savedScrollY > 0) {
      requestAnimationFrame(() => { window.scrollTo(0, savedScrollY); savedScrollY = 0; });
    }
  }, []);

  // Load first page
  useEffect(() => {
    if (cache) return;
    (async () => {
      pageRef.current = 1;
      try {
        const d = await fetch(`/api/random-preview/${seed}?page=1&perPage=60`).then(r => r.json());
        previewCache[seed] = { images: d.images, total: d.total, hasNext: d.hasNext, page: d.page };
        setImages(d.images);
        setTotal(d.total);
        setHasNext(d.hasNext);
        pageRef.current = d.page;
      } catch (e) {
        console.error('Load failed:', e);
      }
      setLoaded(true);
    })();
  }, [seed]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNext || loadingMore) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasNext && !loadingMore) loadMore();
    }, { rootMargin: '400px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNext, loadingMore, images.length, seed]);

  const loadMore = async () => {
    if (!hasNext || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await fetch(`/api/random-preview/${seed}?page=${pageRef.current + 1}&perPage=60`).then(r => r.json());
      const merged = [...images, ...d.images];
      previewCache[seed] = { images: merged, total: d.total, hasNext: d.hasNext, page: d.page };
      setImages(merged);
      setTotal(d.total);
      setHasNext(d.hasNext);
      pageRef.current = d.page;
    } catch (e) {
      console.error('Load more failed:', e);
    }
    setLoadingMore(false);
  };

  const loadAll = async () => {
    if (!hasNext || loadingAll) return;
    setLoadingAll(true);
    try {
      let nextPage = pageRef.current + 1;
      while (true) {
        const d = await fetch(`/api/random-preview/${seed}?page=${nextPage}&perPage=60`).then(r => r.json());
        const merged = [...images, ...d.images];
        previewCache[seed] = { images: merged, total: d.total, hasNext: d.hasNext, page: d.page };
        setImages(merged);
        setTotal(d.total);
        setHasNext(d.hasNext);
        pageRef.current = d.page;
        if (!d.hasNext) break;
        nextPage = d.page + 1;
      }
    } catch (e) {
      console.error('Load all failed:', e);
    }
    setLoadingAll(false);
  };

  const waterfallRef = useRef(null);
  const numCols = useColumnCount();

  const columns = useMemo(() => {
    const gap = Math.min(8, Math.max(3, window.innerWidth * 0.005));
    const containerWidth = waterfallRef.current?.clientWidth || (window.innerWidth - 32 * 2);
    const colWidth = (containerWidth - (numCols - 1) * gap) / numCols;
    const cols = Array.from({ length: numCols }, () => []);
    const colHeights = new Array(numCols).fill(0);
    const DEFAULT_RATIO = 4 / 3;
    images.forEach((img, i) => {
      const ratio = img.w && img.h ? img.w / img.h : DEFAULT_RATIO;
      const itemH = colWidth / ratio + gap;
      let minIdx = 0;
      for (let c = 1; c < numCols; c++) { if (colHeights[c] < colHeights[minIdx]) minIdx = c; }
      colHeights[minIdx] += itemH;
      cols[minIdx].push({ ...img, globalIdx: i });
    });
    return cols;
  }, [images, numCols]);

  const goBack = () => window.history.back();
  const openLb = idx => { setLbIndex(idx); lbRef.current = true; history.pushState(null, ''); };
  const closeLb = (lastIdx) => {
    if (lbRef.current) {
      lbRef.current = false;
      setLbIndex(-1);
      history.back();
      if (lastIdx !== undefined) {
        setTimeout(() => {
          const el = document.querySelector(`[data-global="${lastIdx}"]`);
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            setTimeout(() => {
              el.classList.add('focus-flash');
              setTimeout(() => el.classList.remove('focus-flash'), 3000);
            }, 500);
          }
        }, 100);
      }
    }
  };
  const remaining = total - images.length;

  return (
    <div className={`app app--gallery${isFs ? ' app--fullscreen' : ''}`}>
      <header className="header">
        <div className="detail-header-left">
          <button className="back-btn" onClick={goBack}>← Back</button>
          <div className="detail-info">
            <div className="detail-title">随机预览</div>
            <div className="detail-sub">{total} images · seed #{seed}</div>
          </div>
        </div>
        <div className="header-actions">
          {hasNext && !loadingAll && <button className="theme-btn" onClick={loadAll}>Load All</button>}
          {loadingAll && <span className="header-count" style={{color:'var(--muted)'}}>Loading…</span>}
          <button className="theme-btn" onClick={toggleFs} title={isFs ? 'Exit' : 'Fullscreen'}>{isFs ? '⤓' : '⤢'}</button>
          <ThemeBtn />
        </div>
      </header>

      {!loaded ? (
        <div className="loading">
          <div><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>
          <div className="loading-text">Loading random images…</div>
        </div>
      ) : images.length === 0 ? (
        <div className="empty"><div className="empty-icon">○</div><div className="empty-text">No images found</div></div>
      ) : (
        <>
          <div className="waterfall" ref={waterfallRef}>
            {columns.map((colImgs, ci) => (
              <div className="waterfall-col" key={ci}>
                {colImgs.map(img => (
                  <div className="w-item w-item--random" key={img.url} data-global={img.globalIdx} onClick={() => openLb(img.globalIdx)}
                    style={img.w && img.h ? { aspectRatio: img.w / img.h } : undefined}>
                    <img src={img.url} alt="" loading="lazy"
                      onLoad={e => e.target.classList.add('loaded')} />
                    <div className="w-item-overlay">
                      <a className="w-item-title" href={`/gallery/${img.gid}?focus=${encodeURIComponent(img.url.split('/').pop())}`}
                        onClick={e => { e.stopPropagation(); savedScrollY = window.scrollY; }}
                        title="Click to view gallery">
                        {img.title || '#' + img.gid}
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="load-more-wrap" ref={sentinelRef}>
            {loadingMore ? (
              <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>Loading…</span>
            ) : hasNext ? (
              <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>Scroll for more ({remaining} remaining)</span>
            ) : (
              <span style={{ fontSize: '.7rem', color: 'var(--muted)' }}>All {total} images</span>
            )}
          </div>
        </>
      )}

      {lbIndex >= 0 && lbIndex < images.length && <>
        <Lightbox images={images} initialIndex={lbIndex} onClose={closeLb} onLoadMore={loadMore} loadingMore={loadingMore} isFs={isFs} onIndexChange={idx => lbIdxRef.current = idx} />
      </>}
      <AutoScroll lightboxOpen={lbIndex >= 0} />
    </div>
  );
}

// Responsive column count hook
function useColumnCount() {
  const [numCols, setNumCols] = useState(() => {
    const w = window.innerWidth;
    if (w <= 400) return 1;
    if (w <= 640) return 2;
    if (w <= 1024) return 3;
    return 4;
  });
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      setNumCols(w <= 400 ? 1 : w <= 640 ? 2 : w <= 1024 ? 3 : 4);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return numCols;
}
