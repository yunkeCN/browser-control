#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..', '..');
const dirs = ['bin', 'extension', 'skills', 'tests', 'scripts'];
const files = [];
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(p);
  }
}
for (const d of dirs) {
  const full = path.join(root, d);
  if (exists(full)) walk(full);
}
let failed = false;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) { failed = true; process.stderr.write(r.stderr || r.stdout); }
}
if (failed) process.exit(1);
console.log(`lint ok: ${files.length} JavaScript/MJS files parsed; TypeScript source is covered by npm run typecheck`);
