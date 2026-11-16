'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../apps/frontend/dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
};
function createFrontendServer({ apiPort = 3150, timeoutMs = 10000 } = {}) {
  return http.createServer((req, res) => {
    let requested;
    try {
      requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (/^\/api(?:\/|$)/.test(requested)) {
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${apiPort}`, connection: 'close' },
        },
        (response) => {
          res.writeHead(response.statusCode || 502, response.headers);
          response.on('error', () => res.destroy());
          response.pipe(res);
        },
      );
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('API timeout')));
      upstream.on('error', () => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ message: 'Сервер студии недоступен. Проверьте запуск прототипа.' }),
        );
      });
      req.on('aborted', () => upstream.destroy());
      req.on('error', () => upstream.destroy());
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    let file = path.resolve(root, '.' + requested);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, 'index.html');
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404);
        return res.end('Build frontend first.');
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
}
module.exports = { createFrontendServer };
if (require.main === module)
  createFrontendServer().listen(9150, '127.0.0.1', () =>
    console.log('Krugi frontend: http://127.0.0.1:9150'),
  );
