import {readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build as viteBuild} from 'vite';
import {build as esbuild} from 'esbuild';
import {viteSingleFile} from 'vite-plugin-singlefile';
import {createContentPolicy} from '@saga-a2ui/components/faithful-card';
import {embedPolicy, STANDARD_POLICY_CONFIGURATION} from '../src/view/embed-document.js';
import {APP_VERSION} from '../src/version.js';
import {BRANDING} from '../src/view/branding.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
rmSync(dist, {recursive: true, force: true});
mkdirSync(dist, {recursive: true});
await viteBuild({
  configFile: false,
  root: path.join(root, 'src/view'),
  base: './',
  plugins: [viteSingleFile(), {
    name: 'ansari-brand',
    transformIndexHtml: html => html.replaceAll('{{brand.name}}', BRANDING.name).replaceAll('{{release}}', APP_VERSION),
  }],
  esbuild: {jsx: 'automatic'},
  build: {
    outDir: dist, emptyOutDir: false, target: 'es2022', cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {input: path.join(root, 'src/view/mcp-app-react.html')},
  },
});
const policy = createContentPolicy(STANDARD_POLICY_CONFIGURATION);
if (!policy.ok) throw new Error(policy.failure.message);
const built = path.join(dist, 'mcp-app-react.html');
writeFileSync(path.join(dist, 'view.html'), embedPolicy(readFileSync(built, 'utf8'), policy.policy));
rmSync(built);
await esbuild({
  absWorkingDir: root, entryPoints: ['src/server/index.ts'], outfile: 'dist/server/index.js',
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: {js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"},
});
