import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'bin', 'browser-control-mcp.mjs');
const skillOutFile = path.join(root, 'skills', 'browser-control', 'scripts', 'browser-control-mcp.mjs');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.mkdirSync(path.dirname(skillOutFile), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'mcp', 'server.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  external: [
    'node:*'
  ],
  define: {
    __BROWSER_CONTROL_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
    __BROWSER_CONTROL_MCP_SELF_CONTAINED__: 'true'
  },
  banner: {
    js: [
      'import { createRequire as __browserControlCreateRequire } from "node:module";',
      'const require = __browserControlCreateRequire(import.meta.url);'
    ].join('\n')
  },
  logLevel: 'silent'
});

fs.chmodSync(outFile, 0o755);
fs.copyFileSync(outFile, skillOutFile);
fs.chmodSync(skillOutFile, 0o755);
console.log(`mcp build ok: ${path.relative(root, outFile)} and ${path.relative(root, skillOutFile)}`);
