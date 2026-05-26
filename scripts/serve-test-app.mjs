#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'src', 'test_app');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, statusCode, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function resolveRequestPath(url) {
  const parsed = new URL(url, `http://${host}:${port}`);
  const pathname = decodeURIComponent(parsed.pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(appRoot, requested));
  if (filePath !== appRoot && !filePath.startsWith(appRoot + path.sep)) {
    return null;
  }
  return filePath;
}

const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    send(res, 405, 'Method not allowed');
    return;
  }

  const filePath = resolveRequestPath(req.url || '/');
  if (!filePath) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const type = contentTypes[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set PORT=4174 or stop the existing server.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Test app available at http://${host}:${port}/`);
});
