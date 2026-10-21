// A transfer/release gate, separate from local candidate development.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const name of ['core', 'components', 'mcp', 'react']) {
  const pkg = `@saga-a2ui/${name}`;
  const version = manifest.dependencies[pkg];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${pkg}: pin a verified public release before transfer (currently ${version})`);
  }
  const found = JSON.parse(execFileSync('npm', ['view', `${pkg}@${version}`, 'version', '--json', '--registry=https://registry.npmjs.org'], {encoding: 'utf8'}));
  if (found !== version) throw new Error(`${pkg}@${version} is not a verified registry release`);
}
console.log('All SAGA dependencies are pinned public releases.');
