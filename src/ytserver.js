// Крошечный локальный сервер (только 127.0.0.1) для страницы с плеером YouTube.
// YouTube не встраивается в страницы file://, ему нужен обычный http-адрес.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'renderer', 'yt');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

let server = null;
let port = 0;

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const name = req.url.split('?')[0] === '/' ? 'player.html' : path.basename(req.url.split('?')[0]);
      const type = TYPES[path.extname(name)];
      if (!type) { res.writeHead(404); return res.end(); }
      fs.readFile(path.join(ROOT, name), (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        // referrer нужен YouTube, чтобы принять встраивание
        res.writeHead(200, { 'Content-Type': type, 'Referrer-Policy': 'strict-origin-when-cross-origin' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

module.exports = { start };
