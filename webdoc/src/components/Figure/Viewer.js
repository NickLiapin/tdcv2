import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './styles.module.css';

const MIN_SCALE = 0.05;
const MAX_SCALE = 6;
const STEP = 1.3;

const clamp = (v) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

/**
 * A full-screen look at one picture.
 *
 * A node graph is often several thousand pixels wide, and showing it at its
 * natural size turns reading into scrollbar work. So it opens fitted to the
 * window, and from there behaves the way every map does: drag with the hand,
 * wheel to zoom around the pointer, buttons for the same thing, double-click to
 * flip between "the whole picture" and "actual size".
 *
 * The controls carry no words — a figure is shared by three languages, and so is
 * this. The symbols are the label.
 */
export default function Viewer({ src, alt = '', onClose }) {
  const [natural, setNatural] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const frame = useRef(null);
  const grab = useRef(null);
  // A drag that ends on the backdrop must not read as a click on the backdrop,
  // or letting go of the picture throws the reader out of the viewer.
  const moved = useRef(false);

  /** The largest scale that still shows the whole picture, never magnifying. */
  const fitScale = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !natural) return 1;
    return Math.min(1, (box.width - 32) / natural.w, (box.height - 32) / natural.h);
  }, [natural]);

  const fit = useCallback(() => {
    setScale(fitScale());
    setOffset({ x: 0, y: 0 });
  }, [fitScale]);

  // Fit once the browser knows how big the picture is, and again on resize.
  useEffect(() => {
    if (!natural) return undefined;
    fit();
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
    };
  }, [natural, fit]);

  /** Zoom about a point on screen, so what sits under the pointer stays there. */
  const zoomAt = useCallback((clientX, clientY, factor) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    setScale((prev) => {
      const next = clamp(prev * factor);
      const k = next / prev;
      setOffset((o) => ({
        x: clientX - cx - (clientX - cx - o.x) * k,
        y: clientY - cy - (clientY - cy - o.y) * k,
      }));
      return next;
    });
  }, []);

  // React's onWheel is passive, and a passive listener cannot stop the page
  // behind from scrolling — so this one is attached by hand.
  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY / 320));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, STEP);
      else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 1 / STEP);
      else if (e.key === '0') fit();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [zoomAt, fit]);

  const onPointerDown = (e) => {
    grab.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    moved.current = false;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!grab.current) return;
    const next = { x: e.clientX - grab.current.x, y: e.clientY - grab.current.y };
    if (Math.abs(next.x - offset.x) + Math.abs(next.y - offset.y) > 3) moved.current = true;
    setOffset(next);
  };
  const endDrag = () => {
    grab.current = null;
    setDragging(false);
  };

  const percent = Math.round(scale * 100);

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.toolbar}>
        <button
          type="button"
          onClick={() => {
            zoomAt(innerWidth / 2, innerHeight / 2, 1 / STEP);
          }}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className={styles.percent}>{percent}%</span>
        <button
          type="button"
          onClick={() => {
            zoomAt(innerWidth / 2, innerHeight / 2, STEP);
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" onClick={fit} aria-label="Fit to screen">
          ⤢
        </button>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div
        ref={frame}
        className={dragging ? `${styles.frame} ${styles.grabbing}` : styles.frame}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          const whole = fitScale();
          if (Math.abs(scale - whole) < 0.01) {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          } else fit();
        }}
        // The backdrop closes; the picture does not, or a drag that ends on
        // empty space would throw the reader out.
        onClick={(e) => {
          if (e.target === e.currentTarget && !moved.current) onClose();
        }}
        role="presentation"
      >
        <div
          className={styles.stage}
          style={{
            transform: `translate(${String(offset.x)}px, ${String(offset.y)}px) scale(${String(scale)})`,
          }}
        >
          <img
            className={styles.full}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) => {
              setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            }}
          />
        </div>
      </div>
    </div>
  );
}
