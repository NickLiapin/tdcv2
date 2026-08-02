import { useEffect, useState } from 'react';

import useBaseUrl from '@docusaurus/useBaseUrl';
import { useColorMode } from '@docusaurus/theme-common';
import ThemedImage from '@theme/ThemedImage';

import styles from './styles.module.css';
import Viewer from './Viewer';

// An illustration with a caption.
//
// `panel` puts the image on a light card — use it for the input PNGs, which are
// drawn on a transparent background and would otherwise vanish against the dark
// theme. `frame` gives a screenshot its own plate, so it reads as a screenshot
// rather than as loose ink on the page. `zoom` makes the figure open full size
// in an overlay you can scroll around — a node graph is often wider than the
// column it sits in.
//
// `srcDark` is for a picture that exists in two versions, one per theme: the
// Studio canvas is captured in both, and the reader sees the one that matches
// the site they are looking at. Drawings made by the figure scripts need none of
// this — they are stroked in colours chosen to read on either background.
export default function Figure({
  src,
  srcDark,
  alt = '',
  caption,
  panel = false,
  frame = false,
  zoom = false,
  width,
}) {
  const url = useBaseUrl(src);
  const darkUrl = useBaseUrl(srcDark ?? src);
  const { colorMode } = useColorMode();
  const [open, setOpen] = useState(false);

  // Escape closes the overlay. The listener exists only while it is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const className = panel ? styles.panel : frame ? styles.framed : styles.img;
  const picture = (cls) =>
    srcDark === undefined ? (
      <img className={cls} src={url} alt={alt} style={width ? { maxWidth: width } : undefined} />
    ) : (
      <ThemedImage
        className={cls}
        sources={{ light: url, dark: darkUrl }}
        alt={alt}
        loading="lazy"
        style={width ? { maxWidth: width } : undefined}
      />
    );

  return (
    <figure className={styles.figure}>
      {zoom ? (
        <button
          type="button"
          className={styles.zoom}
          onClick={() => {
            setOpen(true);
          }}
          aria-label={caption ?? alt}
        >
          {picture(className)}
        </button>
      ) : (
        picture(className)
      )}
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
      {open ? (
        <Viewer
          src={colorMode === 'dark' ? darkUrl : url}
          alt={alt}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </figure>
  );
}
