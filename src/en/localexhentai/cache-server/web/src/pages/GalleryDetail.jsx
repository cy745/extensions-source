import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getGalleryDetail } from '../api';
import Lightbox from '../components/Lightbox';
import ThemeBtn from '../components/ThemeBtn';

export default function GalleryDetail() {
  const { gid } = useParams();

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

  // Distribute images into columns — each new image goes to the shortest column
  const columns = useMemo(() => {
    // Compute gap matching CSS: clamp(3px, 0.5vw, 8px)
    const gap = Math.min(8, Math.max(3, window.innerWidth * 0.005));
    const containerWidth = waterfallRef.current?.clientWidth || (window.innerWidth - 32 * 2);
    const colWidth = (containerWidth - (numCols - 1) * gap) / numCols;

    const cols = Array.from({ length: numCols }, () => []);
    const colHeights = new Array(numCols).fill(0);
    const DEFAULT_RATIO = 4 / 3; // fallback when dimensions unknown

    images.forEach((img, i) => {
      const ratio = img.w && img.h ? img.w / img.h : DEFAULT_RATIO;
      const itemH = colWidth / ratio + gap; // height including bottom gap
      // Find shortest column
      let minIdx = 0;
      for (let c = 1; c < numCols; c++) {
        if (colHeights[c] < colHeights[minIdx]) minIdx = c;
      }
      colHeights[minIdx] += itemH;
      cols[minIdx].push({ ...img, globalIdx: i });
    });
    return cols;
  }, [images, numCols]);

  useEffect(() => {
    setLoaded(false);
    pageRef.current = 1;
    (async () => {
      try {
        const d = await getGalleryDetail(gid, 1);
        setImages(d.images);
        setTitle(d.title);
        setCoverUrl(d.coverUrl);
        setTotal(d.total);
        setHasNext(d.hasNext);
        pageRef.current = d.page;
      } catch (e) {
        console.error('Load failed:', e);
      }
      setLoaded(true);
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
    setLoadingMore(true);
    try {
      const d = await getGalleryDetail(gid, pageRef.current + 1);
      setImages(prev => [...prev, ...d.images]);
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
                  <div className="w-item" key={img.url} onClick={() => openLb(img.globalIdx)}
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
