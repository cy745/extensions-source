import { useEffect, useRef, useState } from 'react';

export default function Lightbox({ images, index, onClose, onPrev, onNext }) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => { setLoaded(false); }, [index]);

  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onPrev();
      else if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, onPrev, onNext]);

  const img = images[index];
  if (!img) return null;

  return (
    <div className="lightbox active" onClick={e => e.target === e.currentTarget && onClose()}>
      <button className="lightbox-close" onClick={onClose}>✕</button>
      {index > 0 && <button className="lightbox-nav lightbox-prev" onClick={onPrev}>‹</button>}
      {index < images.length - 1 && <button className="lightbox-nav lightbox-next" onClick={onNext}>›</button>}
      <img
        className={`lightbox-img${loaded ? ' loaded' : ''}`}
        ref={imgRef}
        src={img.url}
        alt=""
        onLoad={() => setLoaded(true)}
        onClick={e => e.stopPropagation()}
      />
      <div className="lightbox-info">{index + 1} / {images.length}</div>
    </div>
  );
}
