import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getGalleryOverview } from '../api';
import ThemeBtn from '../components/ThemeBtn';

const PER_PAGE = 24;

// Module-level cache — survives component unmount/remount across route changes
let cached = null;
let cachedPage = 1;
let cachedHasNext = false;
let cachedTotal = 0;

export default function GalleryOverview() {
  const navigate = useNavigate();
  const [galleries, setGalleries] = useState(cached || []);
  const [total, setTotal] = useState(cachedTotal);
  const [hasNext, setHasNext] = useState(cachedHasNext);
  const [loaded, setLoaded] = useState(!!cached);
  const [loadingMore, setLoadingMore] = useState(false);

  const pageRef = useRef(cachedPage);
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (cached) return;
    (async () => {
      try {
        const d = await getGalleryOverview(1, PER_PAGE);
        cached = d.list;
        cachedTotal = d.total;
        cachedHasNext = d.hasNext;
        cachedPage = d.page;
        setGalleries(d.list);
        setTotal(d.total);
        setHasNext(d.hasNext);
        pageRef.current = d.page;
      } catch (e) {
        console.error('Load failed:', e);
      }
      setLoaded(true);
    })();
  }, []);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNext || loadingMore) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasNext && !loadingMore) {
        loadMore();
      }
    }, { rootMargin: '400px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNext, loadingMore, galleries.length]);

  const loadMore = async () => {
    if (!cachedHasNext || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await getGalleryOverview(cachedPage + 1, PER_PAGE);
      cached = [...cached, ...d.list];
      cachedTotal = d.total;
      cachedHasNext = d.hasNext;
      cachedPage = d.page;
      setGalleries([...cached]);
      setTotal(d.total);
      setHasNext(d.hasNext);
      pageRef.current = d.page;
    } catch (e) {
      console.error('Load more failed:', e);
    }
    setLoadingMore(false);
  };

  const remaining = total - galleries.length;

  return (
    <div className="app app--gallery">
      <header className="header">
        <div className="header-left">
          <h1>Gallery</h1>
          {loaded && <span className="header-count">{total} galleries</span>}
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
          <div className="loading-text">Loading galleries…</div>
        </div>
      ) : galleries.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">○</div>
          <div className="empty-text">No galleries downloaded yet</div>
        </div>
      ) : (
        <>
          <div className="overview-grid">
            {galleries.map(g => (
              <div
                className="og-card"
                key={g.gid}
                onClick={() => navigate(`/gallery/${g.gid}`)}
              >
                {g.firstImageUrl && <img src={g.firstImageUrl} alt="" loading="lazy" onLoad={e => e.target.classList.add('loaded')} />}
                <div className="gradient" />
                <div className="title-wrap">
                  <div className="g-title">{g.title || '#' + g.gid}</div>
                  <div className="g-count">{g.totalImages} pages</div>
                </div>
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
                All {total} galleries
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
