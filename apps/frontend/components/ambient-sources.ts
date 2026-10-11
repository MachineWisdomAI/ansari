/**
 * The ambient clip's assets as native bundles them: the H.264 MP4 and
 * its poster, nothing else.
 *
 * Native is phone-only and hands AVPlayer/ExoPlayer the MP4 alone, so
 * the WebM twin and the desktop clip would only be dead weight — and on
 * Android they are worse than that. Metro copies every required asset
 * into `res/raw/` under a name built from its path WITHOUT the
 * extension, so `ambient-shadow.webm` and `ambient-shadow.mp4` become
 * the same resource and `packageReleaseResources` fails on the
 * duplicate (#273). That is why the split is a platform *file*: Metro
 * never even resolves the web module's requires for a native build.
 * `ambient-sources.web.ts` carries both encodings for the browser.
 */
export interface AmbientClip {
  /** H.264 — plays everywhere, and the only clip native is ever given. */
  mp4: number;
  /** VP9 — web only, for a Chromium that cannot demux H.264. */
  webm?: number;
  poster: number;
}

export const portraitClip: AmbientClip = {
  mp4: require('@/assets/video/ambient-shadow.mp4'),
  poster: require('@/assets/video/ambient-shadow-poster.jpg'),
};

/** Native has no desktop width; the portrait clip stands in. */
export const desktopClip: AmbientClip = portraitClip;
