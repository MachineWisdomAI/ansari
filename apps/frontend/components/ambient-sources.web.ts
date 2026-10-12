import type { AmbientClip } from './ambient-sources';

/**
 * The ambient clip's assets on the web: both encodings of each clip,
 * because no single one plays in every browser. Which one a browser is
 * handed is decided by `webPrefersMp4` in `AmbientVideo.tsx`. Native
 * resolves `ambient-sources.ts` instead, which never requires a WebM —
 * see the note there for why it must not (#273).
 */
export const portraitClip: AmbientClip = {
  mp4: require('@/assets/video/ambient-shadow.mp4'),
  webm: require('@/assets/video/ambient-shadow.webm'),
  poster: require('@/assets/video/ambient-shadow-poster.jpg'),
};

// Desktop-width web gets a landscape twin so the shadow fills a wide
// window without the hard cropping the portrait clip suffers. Carried in
// both encodings for the same reason the portrait clip is — desktop
// Safari is no more willing to decode VP9 than the phone is.
export const desktopClip: AmbientClip = {
  mp4: require('@/assets/video/ambient-shadow-desktop.mp4'),
  webm: require('@/assets/video/ambient-shadow-desktop.webm'),
  poster: require('@/assets/video/ambient-shadow-desktop-poster.jpg'),
};
