'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const BROWSER_CONTROL_HOME = process.env.BROWSER_CONTROL_HOME || path.join(os.homedir(), '.browser-control');
const DEFAULT_ARTIFACT_DIR = process.env.BROWSER_CONTROL_ARTIFACT_DIR || path.join(BROWSER_CONTROL_HOME, 'artifacts');

const MIME_BY_KIND = {
  screenshot: { png: 'image/png', jpeg: 'image/jpeg' },
  pdf: { pdf: 'application/pdf' },
  download: { bin: 'application/octet-stream' },
  network: { txt: 'text/plain', json: 'application/json', bin: 'application/octet-stream' },
  observation: { json: 'application/json', txt: 'text/plain' }
};

function sanitizeName(name) {
  return String(name || 'artifact')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120) || 'artifact';
}

class ArtifactStore {
  constructor(rootDir = DEFAULT_ARTIFACT_DIR) {
    this.rootDir = rootDir;
  }

  ensureDir(kind) {
    const dir = path.join(this.rootDir, kind, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeBase64(kind, base64, options = {}) {
    if (!base64 || typeof base64 !== 'string') return null;
    const ext = (options.ext || options.format || 'bin').replace(/^\./, '').toLowerCase();
    const dir = this.ensureDir(kind);
    const hash = crypto.createHash('sha256').update(base64).digest('hex').slice(0, 12);
    const filename = `${sanitizeName(options.name || kind)}-${Date.now()}-${hash}.${ext}`;
    const filePath = path.join(dir, filename);
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(filePath, buffer);
    return {
      id: `${kind}-${hash}`,
      kind,
      path: filePath,
      fileName: filename,
      mimeType: options.mimeType || MIME_BY_KIND[kind]?.[ext] || 'application/octet-stream',
      sizeBytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  writeText(kind, text, options = {}) {
    if (text === undefined || text === null) return null;
    const ext = (options.ext || 'txt').replace(/^\./, '').toLowerCase();
    const dir = this.ensureDir(kind);
    const hash = crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
    const filename = `${sanitizeName(options.name || kind)}-${Date.now()}-${hash}.${ext}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, String(text));
    const stat = fs.statSync(filePath);
    return {
      id: `${kind}-${hash}`,
      kind,
      path: filePath,
      fileName: filename,
      mimeType: options.mimeType || MIME_BY_KIND[kind]?.[ext] || 'text/plain',
      sizeBytes: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    };
  }
}

function extractArtifacts(command, result, store = new ArtifactStore()) {
  const artifacts = [];
  const data = result && typeof result === 'object' ? { ...result } : result;

  if (!result || typeof result !== 'object') return { data, artifacts };

  if (command === 'screenshot' && result.data) {
    const artifact = store.writeBase64('screenshot', result.data, {
      ext: result.format || 'png',
      format: result.format || 'png',
      name: result.fileName || 'screenshot'
    });
    if (artifact) artifacts.push(artifact);
    delete data.data;
    data.artifact = artifact;
  }

  if (command === 'save_as_pdf' && result.data) {
    const artifact = store.writeBase64('pdf', result.data, {
      ext: 'pdf',
      name: result.fileName || 'page'
    });
    if (artifact) artifacts.push(artifact);
    delete data.data;
    data.artifact = artifact;
  }

  if ((command === 'network' || command === 'network_detail') && typeof result.body === 'string' && result.body.length > 16 * 1024) {
    const artifact = result.base64Encoded
      ? store.writeBase64('network', result.body, { ext: 'bin', name: `network-${result.requestId || 'body'}` })
      : store.writeText('network', result.body, { ext: 'txt', name: `network-${result.requestId || 'body'}` });
    if (artifact) artifacts.push(artifact);
    delete data.body;
    data.bodyArtifact = artifact;
  }

  if (command === 'download' && result.path) {
    artifacts.push({
      id: `download-${path.basename(result.path)}`,
      kind: 'download',
      path: result.path,
      fileName: path.basename(result.path),
      mimeType: result.mimeType || 'application/octet-stream',
      sizeBytes: result.sizeBytes || null
    });
  }

  return { data, artifacts };
}

module.exports = { ArtifactStore, extractArtifacts, DEFAULT_ARTIFACT_DIR };
