#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['bin', 'extension', 'skills', 'tests', 'scripts'];
const files = [];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

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
  if (r.status !== 0) {
    failed = true;
    process.stderr.write(r.stderr || r.stdout);
  }
}

if (failed) process.exit(1);
console.log(`lint ok: ${files.length} JavaScript/MJS files parsed; TypeScript source is covered by npm run typecheck`);
