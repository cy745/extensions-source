import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getGalleryDetail } from '../api';
import Lightbox from '../components/Lightbox';
import ThemeBtn from '../components/ThemeBtn';

// Module-level cache — survives unmount/remount across route changes
const previewCache = {};
let savedScrollY = 0;

function goToGallery(gid, filename) {
  savedScrollY = window.scrollY;
  window.location.href = `/gallery/${gid}?focus=${encodeURIComponent(filename)}`;
}

export default function RandomPreview() {
  const { seed } = useParams();
  const nav = useNavigate();

  const cache = previewCache[seed];

  const [images, setImages] = useState(cache?.images || []);
  const [total, setTotal] = useState(cache?.total || 0);
  const [hasNext, setHasNext] = useState(cache?.hasNext ?? true);
  const [loaded, setLoaded] = useState(!!cache);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lbIndex, setLbIndex] = useState(-1);

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
  const openLb = idx => setLbIndex(idx);
  const closeLb = () => setLbIndex(-1);
  const prevLb = () => setLbIndex(i => Math.max(0, i - 1));
  const nextLb = () => setLbIndex(i => Math.min(images.length - 1, i + 1));
  const remaining = total - images.length;

  return (
    <div className="app app--gallery">
      <header className="header">
        <div className="detail-header-left">
          <button className="back-btn" onClick={goBack}>← Back</button>
          <div className="detail-info">
            <div className="detail-title">随机预览</div>
            <div className="detail-sub">{total} images · seed #{seed}</div>
          </div>
        </div>
        <div className="header-actions"><ThemeBtn /></div>
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
                  <div className="w-item w-item--random" key={img.url} onClick={() => openLb(img.globalIdx)}
                    style={img.w && img.h ? { aspectRatio: img.w / img.h } : undefined}>
                    <img src={img.url} alt="" loading="lazy"
                      onLoad={e => e.target.classList.add('loaded')} />
                    <div className="w-item-overlay">
                      <span className="w-item-title" onClick={e => { e.stopPropagation(); goToGallery(img.gid, img.url.split('/').pop()); }}
                        title="Click to view gallery">
                        {img.title || '#' + img.gid}
                      </span>
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

      {lbIndex >= 0 && lbIndex < images.length && (
        <Lightbox images={images} index={lbIndex} onClose={closeLb} onPrev={prevLb} onNext={nextLb} />
      )}
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
