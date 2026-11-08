// Простой локальный сервер для просмотра и тестов: node tests/serve.js [порт]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.pdf': 'application/pdf'
};

function start(port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const s = range[1] ? Number(range[1]) : 0;
        const e = range[2] ? Number(range[2]) : st.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
        return fs.createReadStream(file, { start: s, end: e }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8080;
  start(port).then(() => console.log(`Сайт: http://localhost:${port}/  Админка: http://localhost:${port}/admin.html`));
}

module.exports = { start };
