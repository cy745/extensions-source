import { useCallback, useEffect, useRef, useState } from 'react';

const SPEED_MIN = 0;
const SPEED_MAX = 5;
const SPEED_STEP = 0.5;

export default function AutoScroll({ lightboxOpen }) {
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState(0);
  const rafId = useRef(null);
  const pauseTimer = useRef(null);
  const paused = useRef(false);
  const lastTime = useRef(0);
  const accum = useRef(0);
  const [loopStart, setLoopStart] = useState(null);
  const [loopEnd, setLoopEnd] = useState(null);
  const loopStartRef = useRef(null);
  const loopEndRef = useRef(null);

  const markStart = () => { const y = window.scrollY; setLoopStart(y); loopStartRef.current = y; };
  const markEnd = () => { const y = window.scrollY; setLoopEnd(y); loopEndRef.current = y; };
  const clearLoop = () => { setLoopStart(null); setLoopEnd(null); loopStartRef.current = null; loopEndRef.current = null; };

  const stop = useCallback(() => {
    if (rafId.current) { cancelAnimationFrame(rafId.current); rafId.current = null; }
  }, []);

  const pause = useCallback((duration) => {
    paused.current = true;
    clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => { paused.current = false; }, duration);
  }, []);

  // Continuous scroll loop (runs regardless of panel open/close)
  useEffect(() => {
    if (speed <= 0) { stop(); return; }
    paused.current = false;
    let running = true;

    const tick = (time) => {
      if (!running) return;
      if (!paused.current) {
        const end = loopEndRef.current;
        const start = loopStartRef.current;
        // If loop end is set and we've reached/passed it, jump to start
        if (end !== null && window.scrollY >= end) {
          const target = start !== null ? start : 0;
          window.scrollTo({ top: target, behavior: 'auto' });
          accum.current = 0;
        } else {
          const delta = lastTime.current ? Math.min(time - lastTime.current, 50) : 16;
          accum.current += speed * (delta / 16);
          const px = Math.floor(accum.current);
          if (px >= 1) { window.scrollBy({ top: px, behavior: 'auto' }); accum.current -= px; }
        }
      }
      lastTime.current = time;
      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    return () => { running = false; stop(); };
  }, [speed, open, stop]);

  // Pause on user scroll (wheel)
  useEffect(() => {
    if (speed <= 0) return;
    const onWheel = () => pause(1000);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  }, [speed, pause]);

  // Pause on keyboard (arrow up/down, page up/down, space)
  useEffect(() => {
    if (speed <= 0) return;
    const onKey = (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '].includes(e.key)) pause(1000);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speed, pause]);

  // Pause when lightbox opens, resume 2s after close
  useEffect(() => {
    if (speed <= 0 || !open) return;
    if (lightboxOpen) {
      paused.current = true;
      clearTimeout(pauseTimer.current);
    } else if (paused.current) {
      pauseTimer.current = setTimeout(() => { paused.current = false; }, 2000);
    }
  }, [lightboxOpen, speed, open]);

  const handleSpeedChange = (val) => {
    const v = parseFloat(val);
    setSpeed(isNaN(v) ? 0 : Math.max(SPEED_MIN, Math.min(SPEED_MAX, v)));
    lastTime.current = 0; accum.current = 0; // reset on speed change
  };

  const percentage = speed > 0 ? ((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100 : 0;

  return (
    <div className={`auto-scroll${open ? ' open' : ''}`}>
      {!open && (
        <button className={`as-fab${speed > 0 ? ' active' : ''}`} onClick={() => setOpen(true)} title="Auto Scroll">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <polyline points="8 18 12 22 16 18" />
            <polyline points="8 6 12 2 16 6" />
            <line x1="12" y1="2" x2="12" y2="22" />
          </svg>
        </button>
      )}
      {open && (
        <div className="as-panel">
          <div className="as-header">
            <span className="as-label">Auto Scroll</span>
            <button className="as-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="as-body">
            <div className="as-slider-row">
              <input type="range" className="as-slider" min={SPEED_MIN} max={SPEED_MAX} step={SPEED_STEP}
                value={speed} onChange={e => handleSpeedChange(e.target.value)} />
              <span className="as-value">{speed.toFixed(1)}</span>
            </div>
            {speed > 0 && (
              <div className="as-pill" onClick={() => setSpeed(0)}>● Scrolling at {speed.toFixed(1)}px/f — tap to stop</div>
            )}
            <div className="as-loop">
              <button className={`as-btn${loopStart !== null ? ' active' : ''}`} onClick={markStart}
                title="Set loop start">↰ Start</button>
              <button className={`as-btn${loopEnd !== null ? ' active' : ''}`} onClick={markEnd}
                title="Set loop end">↳ End</button>
              {(loopStart !== null || loopEnd !== null) && (
                <button className="as-btn as-btn--clear" onClick={clearLoop} title="Clear loop">✕</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
