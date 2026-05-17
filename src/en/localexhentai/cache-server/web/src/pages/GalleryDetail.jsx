import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { getGalleryDetail } from '../api';
import Lightbox from '../components/Lightbox';
import ThemeBtn from '../components/ThemeBtn';

export default function GalleryDetail() {
  const { gid } = useParams();
  const [searchParams] = useSearchParams();
  const focusFile = searchParams.get('focus');
  const focusRef = useRef(null);

  const [images, setImages] = useState([]);
  const [title, setTitle] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [total, setTotal] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lbIndex, setLbIndex] = useState(-1);
  const [loadingMore, setLoadingMore] = useState(false);
  const lbRef = useRef(false);
  const sentinelRef = useRef(null);

  // Intercept browser back to close lightbox instead of navigating
  useEffect(() => {
    const onPop = () => {
      if (lbRef.current) {
        setLbIndex(-1);
        lbRef.current = false;
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const pageRef = useRef(1);

  // Responsive column count (matches old CSS column breakpoints)
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

  const waterfallRef = useRef(null);

  // Column state — updated incrementally so existing items keep their DOM
  const [columns, setColumns] = useState([]);
  const colHeightsRef = useRef([]);
  const colsRef = useRef([]);
  const gapRef = useRef(0);
  const numColsRef = useRef(numCols);
  numColsRef.current = numCols;

  // Compute gap and column width
  function getLayout() {
    const gap = Math.min(8, Math.max(3, window.innerWidth * 0.005));
    const cw = waterfallRef.current?.clientWidth || (window.innerWidth - 32 * 2);
    return { gap, colWidth: (cw - (numCols - 1) * gap) / numCols };
  }

  // Distribute a batch of images to shortest columns, returns [newCols, newHeights]
  function pushToCols(items, existingCols, existingHeights) {
    const { gap, colWidth } = getLayout();
    const cols = existingCols || Array.from({ length: numCols }, () => []);
    const heights = existingHeights || new Array(numCols).fill(0);
    const DEFAULT_RATIO = 4 / 3;
    items.forEach((img, i) => {
      const ratio = img.w && img.h ? img.w / img.h : DEFAULT_RATIO;
      const itemH = colWidth / ratio + gap;
      let minIdx = 0;
      for (let c = 1; c < numCols; c++) { if (heights[c] < heights[minIdx]) minIdx = c; }
      heights[minIdx] += itemH;
      cols[minIdx].push({ ...img, globalIdx: img.globalIdx ?? i });
    });
    return { cols, heights };
  }

  // When images change completely (initial load), rebuild columns
  function rebuildCols(allImages) {
    const { cols, heights } = pushToCols(allImages);
    colsRef.current = cols;
    colHeightsRef.current = heights;
    gapRef.current = getLayout().gap;
    setColumns(cols);
  }

  // When new images are loaded (loadMore), only append to shortest columns
  function appendCols(newImages) {
    const startIdx = columns.flat().length;
    const items = newImages.map((img, i) => ({ ...img, globalIdx: startIdx + i }));
    const { cols, heights } = pushToCols(items, colsRef.current, colHeightsRef.current);
    colsRef.current = cols;
    colHeightsRef.current = heights;
    setColumns([...cols]); // trigger re-render with same column refs
  }

  // Rebuild on numCols change (window resize)
  useEffect(() => {
    if (columns.length > 0 && columns.flat().length > 0) {
      const all = columns.flat().sort((a, b) => a.globalIdx - b.globalIdx);
      rebuildCols(all);
    }
  }, [numCols]);

  useEffect(() => {
    setLoaded(false);
    pageRef.current = 1;
    (async () => {
      // If focus param, find which page and load up to it
      let targetPage = 1;
      let focusGlobalIdx = -1;
      if (focusFile) {
        try {
          const pos = await fetch(`/api/gallery-image-position/${gid}?filename=${encodeURIComponent(focusFile)}`).then(r => r.json());
          targetPage = pos.page;
          focusGlobalIdx = (pos.page - 1) * 60 + pos.indexInPage;
        } catch {}
      }

      try {
        let all = [];
        const first = await getGalleryDetail(gid, 1);
        all = first.images;
        setTitle(first.title);
        setCoverUrl(first.coverUrl);
        setTotal(first.total);
        setHasNext(first.hasNext);
        pageRef.current = first.page;

        // Load subsequent pages if needed
        for (let p = 2; p <= targetPage; p++) {
          const d = await getGalleryDetail(gid, p);
          all = [...all, ...d.images];
          setHasNext(d.hasNext);
          pageRef.current = d.page;
        }
        setTotal(first.total); // total stays the same

        setImages(all);
        rebuildCols(all);
      } catch (e) {
        console.error('Load failed:', e);
      }
      setLoaded(true);

      // Scroll to focused image, flash once element is on screen
      if (focusGlobalIdx >= 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el = document.querySelector(`[data-global="${focusGlobalIdx}"]`);
            if (el) {
              el.scrollIntoView({ block: 'center', behavior: 'smooth' });
              const obs = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting) {
                  obs.disconnect();
                  setTimeout(() => {
                    el.classList.add('focus-flash');
                    setTimeout(() => el.classList.remove('focus-flash'), 3000);
                  }, 300);
                }
              }, { threshold: 0.3 });
              obs.observe(el);
            }
          });
        });
      }
    })();
  }, [gid]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNext || loadingMore) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasNext && !loadingMore) loadMore();
    }, { rootMargin: '400px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNext, loadingMore, images.length, gid]);

  const loadMore = async () => {
    if (!hasNext || loadingMore) return;
    // Remove focus highlight to avoid re-render flash
    document.querySelectorAll('.focus-flash').forEach(el => el.classList.remove('focus-flash'));
    setLoadingMore(true);
    try {
      const d = await getGalleryDetail(gid, pageRef.current + 1);
      setImages(prev => [...prev, ...d.images]);
      appendCols(d.images);
      setTotal(d.total);
      setHasNext(d.hasNext);
      pageRef.current = d.page;
    } catch (e) {
      console.error('Load more failed:', e);
    }
    setLoadingMore(false);
  };

  const goBack = () => window.history.back();
  const openLb = idx => { setLbIndex(idx); lbRef.current = true; history.pushState(null, ''); };
  const closeLb = () => { if (lbRef.current) { lbRef.current = false; setLbIndex(-1); history.back(); } };
  const prevLb = () => { if (lbIndex > 0) setLbIndex(i => i - 1); };
  const nextLb = () => { if (lbIndex < images.length - 1) setLbIndex(i => i + 1); };

  const remaining = total - images.length;

  return (
    <div className="app app--gallery">
      <header className="header">
        <div className="detail-header-left">
          <button className="back-btn" onClick={goBack}>← Back</button>
          {coverUrl && <img className="detail-thumb" src={coverUrl} alt="" />}
          <div className="detail-info">
            <div className="detail-title">{title || '#' + gid}</div>
            <div className="detail-sub">{total} pages · GID #{gid}</div>
          </div>
        </div>
        <div className="header-actions">
          <ThemeBtn />
        </div>
      </header>

      {!loaded ? (
        <div className="loading">
          <div>
            <span className="loading-dot" />
            <span className="loading-dot" />
            <span className="loading-dot" />
          </div>
          <div className="loading-text">Loading images…</div>
        </div>
      ) : images.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">○</div>
          <div className="empty-text">No images found</div>
        </div>
      ) : (
        <>
          <div className="waterfall" ref={waterfallRef}>
            {columns.map((colImgs, ci) => (
              <div className="waterfall-col" key={ci}>
                {colImgs.map(img => (
                  <div className="w-item" key={img.url} data-global={img.globalIdx} onClick={() => openLb(img.globalIdx)}
                    style={img.w && img.h ? { aspectRatio: img.w / img.h } : undefined}>
                    <img src={img.url} alt="" loading="lazy"
                      onLoad={e => e.target.classList.add('loaded')} />
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
              <span style={{ fontSize: '.7rem', color: 'var(--muted)' }}>
                All {total} images
              </span>
            )}
          </div>
        </>
      )}

      {lbIndex >= 0 && lbIndex < images.length && (
        <Lightbox
          images={images}
          index={lbIndex}
          onClose={closeLb}
          onPrev={prevLb}
          onNext={nextLb}
        />
      )}
    </div>
  );
}
