import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binOut = path.join(root, 'bin', 'browser-control-ctrl.mjs');
const skillOut = path.join(root, 'skills', 'browser-control', 'scripts', 'browser-control.js');
fs.mkdirSync(path.dirname(binOut), { recursive: true });
fs.mkdirSync(path.dirname(skillOut), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'controller', 'cli.ts')],
  outfile: skillOut,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['node:*'],
  logLevel: 'silent',
});

fs.writeFileSync(skillOut, fs.readFileSync(skillOut, 'utf8').replace(/[ \t]+$/gm, ''));
fs.chmodSync(skillOut, 0o755);
fs.writeFileSync(binOut, `#!/usr/bin/env node
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../skills/browser-control/scripts/browser-control.js');
`);
fs.chmodSync(binOut, 0o755);
console.log(`controller cli build ok: ${path.relative(root, binOut)} and ${path.relative(root, skillOut)}`);
