#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const watchedRoots = [
  'skills/browser-control/extension',
  'skills/browser-control/scripts/vendor/ws'
];

function listFiles(relativeRoot) {
  const fullRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(fullRoot)) return [];
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  }
  walk(fullRoot);
  return files.sort();
}

function read(relativePath) {
  const full = path.join(root, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}

function snapshot() {
  const files = watchedRoots.flatMap(listFiles);
  return new Map(files.map(file => [file, read(file)]));
}

const before = snapshot();
const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-extension.mjs')], {
  cwd: root,
  encoding: 'utf8'
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

const after = snapshot();
const allFiles = [...new Set([...before.keys(), ...after.keys()])].sort();
const changed = [];
for (const file of allFiles) {
  const prev = before.get(file);
  const next = after.get(file);
  if (!prev || !next || !Buffer.from(prev).equals(Buffer.from(next))) changed.push(file);
}

if (changed.length) {
  console.error(`extension build drift detected: ${changed.join(', ')}`);
  console.error('Run npm run build:extension and commit the generated skill extension/vendor output.');
  process.exit(1);
}

console.log('extension build drift check ok');
