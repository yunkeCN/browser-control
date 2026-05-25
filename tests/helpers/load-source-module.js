'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..', '..');

function loadSourceModule(relativePath) {
  const entry = path.join(root, relativePath);
  const source = fs.readFileSync(entry, 'utf8');
  const hash = crypto.createHash('sha256').update(entry).update(source).digest('hex').slice(0, 16);
  const outdir = path.join(os.tmpdir(), 'browser-control-source-modules');
  const outfile = path.join(outdir, `${path.basename(relativePath).replace(/\W+/g, '-')}-${hash}.cjs`);
  fs.mkdirSync(outdir, { recursive: true });

  if (!fs.existsSync(outfile)) {
    esbuild.buildSync({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      logLevel: 'silent'
    });
  }

  return require(outfile);
}

module.exports = { loadSourceModule };
