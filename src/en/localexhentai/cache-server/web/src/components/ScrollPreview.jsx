import { useCallback, useEffect, useMemo, useState } from 'react';

const NUM_THUMBS = 10;

export default function ScrollPreview({ images }) {
  const [scrollPct, setScrollPct] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrollPct(max > 0 ? window.scrollY / max : 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const slots = useMemo(() => {
    if (images.length === 0) return [];
    const result = [];
    for (let i = 0; i < NUM_THUMBS; i++) {
      const idx = Math.round((i / (NUM_THUMBS - 1)) * (images.length - 1));
      if (!result.length || idx !== result[result.length - 1].idx) {
        result.push({ idx, url: images[idx].url });
      }
    }
    return result;
  }, [images]);

  const activeSlot = Math.min(slots.length - 1, Math.round(scrollPct * (slots.length - 1)));

  const handleClick = useCallback((slotIdx) => {
    const targetIdx = slots[slotIdx]?.idx;
    if (targetIdx === undefined) return;
    const el = document.querySelector(`[data-global="${targetIdx}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => {
        el.classList.add('focus-flash');
        setTimeout(() => el.classList.remove('focus-flash'), 3000);
      }, 500);
    }
  }, [slots]);

  // Mini bar — fill from top based on scroll progress
  const fillH = scrollPct * 100;

  if (slots.length < 2) return null;

  return (
    <div className={`scroll-preview${expanded ? ' expanded' : ''}`}>
      {/* Hit area + mini bar (12px at right edge, always visible) */}
      <div className="sp-hit" onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
        <div className="sp-mini">
          <div className="sp-mini-thumb" style={{ top: 0, height: `${fillH}%` }} />
        </div>
      </div>

      {/* Expanded panel (slides in from right on hover) */}
      <div className={`sp-panel${expanded ? ' expanded' : ''}`}
        onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
        {slots.map((s, i) => (
          <div
            key={s.idx}
            className={`sp-thumb${i === activeSlot ? ' active' : ''}${i === hoverIdx ? ' hover' : ''}`}
            onClick={() => handleClick(i)}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(-1)}
          >
            <img src={s.url} alt="" loading="lazy" />
          </div>
        ))}
      </div>
    </div>
  );
}
