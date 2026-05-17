import { useCallback, useEffect, useRef, useState } from 'react';

export default function Lightbox({ images, initialIndex, onClose, onLoadMore, loadingMore, onIndexChange, isFs }) {
  const carouselRef = useRef(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [loaded, setLoaded] = useState(new Set());
  const snapTimer = useRef(null);
  // Shared lerp target accessible from both wheel and button/keyboard
  const lerpTargetRef = useRef(0);
  const lerpRafRef = useRef(null);


  // Report index changes to parent (for scroll-back-on-close)
  useEffect(() => { onIndexChange?.(currentIndex); }, [currentIndex, onIndexChange]);

  // Auto-load more when nearing the end (within 3 slides)
  useEffect(() => {
    if (onLoadMore && currentIndex >= images.length - 3 && !loadingMore) {
      onLoadMore();
    }
  }, [currentIndex, onLoadMore, loadingMore, images.length]);
  useEffect(() => {
    const carousel = carouselRef.current;
    if (carousel && carousel.children[initialIndex + 1]) {
      const el = carousel.children[initialIndex + 1];
      lerpTargetRef.current = el.offsetLeft - (carousel.clientWidth - el.offsetWidth) / 2;
      carousel.scrollLeft = lerpTargetRef.current;
    }
  }, []);

  // Shared lerp animation loop
  const runLerp = useCallback(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    const diff = lerpTargetRef.current - carousel.scrollLeft;
    if (Math.abs(diff) > 0.5) {
      carousel.scrollLeft += diff * 0.1;
      lerpRafRef.current = requestAnimationFrame(runLerp);
    } else {
      carousel.scrollLeft = lerpTargetRef.current;
      lerpRafRef.current = null;
    }
  }, []);

  // Re-sync carousel scroll when fullscreen changes (isFs prop)
  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel || currentIndex < 0) return;
    const slide = carousel.children[currentIndex + 1];
    if (slide) {
      const expected = slide.offsetLeft - (carousel.clientWidth - slide.offsetWidth) / 2;
      carousel.scrollLeft = expected;
      lerpTargetRef.current = expected;
      if (carousel._wt !== undefined) carousel._wt = expected;
    }
  }, [isFs]);

  // Keyboard navigation
  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') onClose(currentIndex);
      else if (e.key === 'ArrowLeft') scrollTo(currentIndex - 1);
      else if (e.key === 'ArrowRight') scrollTo(currentIndex + 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [currentIndex, onClose]);

  // Wheel → lerp + auto-snap on idle
  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;
    document.body.style.overflow = 'hidden';
    carousel._wt = carousel.scrollLeft;
    const whRafRef = { current: null };
    const localIdx = { current: currentIndex };
    const updateIndex = () => {
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      const slides = carousel.querySelectorAll('.lightbox-slide:not(.lb-spacer)');
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        if (Math.abs(s.offsetLeft + s.offsetWidth / 2 - center) < s.offsetWidth * 0.6) {
          if (i !== localIdx.current) { localIdx.current = i; setCurrentIndex(i); }
          break;
        }
      }
    };

    const animateWheel = () => {
      const diff = carousel._wt - carousel.scrollLeft;
      if (Math.abs(diff) > 0.5) {
        carousel.scrollLeft += diff * 0.12;
        updateIndex();
        whRafRef.current = requestAnimationFrame(animateWheel);
      } else {
        carousel.scrollLeft = carousel._wt;
        whRafRef.current = null;
      }
    };

    const onWheel = e => {
      e.preventDefault();
      if (lerpRafRef.current) { cancelAnimationFrame(lerpRafRef.current); lerpRafRef.current = null; }
      carousel._wt += e.deltaY;
      carousel._wt = Math.max(0, Math.min(carousel._wt, carousel.scrollWidth - carousel.clientWidth));
      lerpTargetRef.current = carousel._wt;
      if (!whRafRef.current) whRafRef.current = requestAnimationFrame(animateWheel);
    };

    carousel._whCancel = () => { if (whRafRef.current) { cancelAnimationFrame(whRafRef.current); whRafRef.current = null; } };
    carousel.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(whRafRef.current);
      if (carousel._whCancel) carousel._whCancel();
      document.body.style.overflow = '';
      carousel.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Scroll to a specific slide index (animated lerp)
  const scrollTo = useCallback((idx) => {
    const carousel = carouselRef.current;
    if (!carousel || idx < 0 || idx >= images.length) return;
    const slide = carousel.children[idx + 1];
    if (slide) {
      setCurrentIndex(idx);
      lerpTargetRef.current = slide.offsetLeft - (carousel.clientWidth - slide.offsetWidth) / 2;
      // Sync wheel target so wheel doesn't jump back after keyboard navigation
      if (carousel._wt !== undefined) carousel._wt = lerpTargetRef.current;
      if (carousel._whCancel) carousel._whCancel();
      if (lerpRafRef.current) { cancelAnimationFrame(lerpRafRef.current); lerpRafRef.current = null; }
      lerpRafRef.current = requestAnimationFrame(runLerp);
    }
  }, [images.length, runLerp]);

  const onImgLoad = (i) => {
    setLoaded(prev => new Set([...prev, i]));
    if (i > 0) setLoaded(prev => new Set([...prev, i - 1]));
    if (i < images.length - 1) setLoaded(prev => new Set([...prev, i + 1]));
  };

  if (!images.length) return null;

  // Spacers are needed so first/last slides can snap to center
  const spacer = <div className="lb-spacer" />;

  return (
    <div className="lightbox active" onClick={e => e.target === e.currentTarget && onClose(currentIndex)}>
      <button className="lightbox-close" onClick={() => onClose(currentIndex)}>✕</button>

      <div className="lightbox-carousel" ref={carouselRef}>
        {spacer}
        {images.map((img, i) => (
          <div className={`lightbox-slide${loaded.has(i) ? ' loaded' : ''}`} key={i}>
            <img
              src={img.url}
              alt=""
              width={img.w || undefined}
              height={img.h || undefined}
              loading={Math.abs(i - currentIndex) <= 1 ? 'eager' : 'lazy'}
              onLoad={() => onImgLoad(i)}
              onClick={e => { e.stopPropagation(); scrollTo(i); }}
              draggable={false}
            />
          </div>
        ))}
        {spacer}
      </div>

      {currentIndex > 0 && (
        <button className="lightbox-nav lightbox-prev" onClick={() => scrollTo(currentIndex - 1)}>‹</button>
      )}
      {currentIndex < images.length - 1 && (
        <button className="lightbox-nav lightbox-next" onClick={() => scrollTo(currentIndex + 1)}>›</button>
      )}

      <div className="lightbox-info">
        {currentIndex + 1} / {images.length}{loadingMore ? ' · Loading…' : ''}
      </div>
    </div>
  );
}
