import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Android packages every bundled asset into `res/raw/` under a name made
// from its path WITHOUT the extension (`assets/video/ambient-shadow.webm`
// -> `assets_video_ambientshadow`), so two formats of one clip collide and
// `packageReleaseResources` fails the release build (#273). iOS copies by
// full path and the web is a static export, so neither ever notices; this
// is the only check short of an EAS build that does.
const appRoot = path.resolve(__dirname, '..');
const sourceDirs = ['app', 'components', 'hooks', 'lib', 'constants'];
const assetRequire = /require\(\s*['"]@\/(assets\/[^'"]+)['"]\s*\)/g;

/** Every app source file Metro can resolve for `platform`: a
 *  `.web.` file is web-only, `.native.`/`.ios.`/`.android.` native-only. */
function sourceFiles(platform: 'android' | 'web'): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const isWeb = /\.web\.tsx?$/.test(entry.name);
        const isNative = /\.(native|ios|android)\.tsx?$/.test(entry.name);
        if (platform === 'web' ? !isNative : !isWeb) out.push(full);
      }
    }
  };
  for (const dir of sourceDirs) walk(path.join(appRoot, dir));
  return out;
}

function requiredAssets(platform: 'android' | 'web'): string[] {
  const assets = new Set<string>();
  for (const file of sourceFiles(platform)) {
    for (const match of readFileSync(file, 'utf8').matchAll(assetRequire)) {
      assets.add(match[1]);
    }
  }
  return [...assets].sort();
}

/** The `res/raw` (or `drawable`) name Android gives an asset path. */
const androidResourceName = (asset: string) =>
  asset
    .replace(/\.[^./]+$/, '')
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/[^a-z0-9_]/g, '');

describe('bundled assets per platform (#273)', () => {
  it('finds the ambient clip among the Android assets (the scan is live)', () => {
    expect(requiredAssets('android')).toContain('assets/video/ambient-shadow.mp4');
  });

  it('bundles no two Android assets under one resource name', () => {
    const byName = new Map<string, string[]>();
    for (const asset of requiredAssets('android')) {
      const name = androidResourceName(asset);
      byName.set(name, [...(byName.get(name) ?? []), asset]);
    }
    const collisions = [...byName.values()].filter((paths) => paths.length > 1);
    expect(collisions).toEqual([]);
  });

  it('bundles no WebM into Android', () => {
    expect(requiredAssets('android').filter((a) => a.endsWith('.webm'))).toEqual([]);
  });

  it('still gives the web both encodings of both clips', () => {
    expect(requiredAssets('web')).toEqual(
      expect.arrayContaining([
        'assets/video/ambient-shadow.webm',
        'assets/video/ambient-shadow.mp4',
        'assets/video/ambient-shadow-desktop.webm',
        'assets/video/ambient-shadow-desktop.mp4',
      ]),
    );
  });
});
