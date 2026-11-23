'use strict';
// Phục vụ CSS/JS/sprite icon đã nén gzip sẵn trong RAM.
// Middleware compression nén lại file ở MỖI lần tải (CSS 80KB ~ vài ms CPU trên Celeron) -> nén 1 lần, dùng lại.
// File đổi (build lại CSS) thì tự nén lại nhờ so mtime + size.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ALLOWED = /^\/(?:(?:css|js)\/[\w.-]+\.(?:css|js)|img\/icons\.svg)$/;
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX = 2 * 1024 * 1024;

module.exports = function staticGzip(root, { maxAge = 0 } = {}) {
  const cache = new Map();
  return function (req, res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !ALLOWED.test(req.path)) return next();
    if (!/\bgzip\b/.test(req.get('accept-encoding') || '')) return next();
    const file = path.join(root, req.path);
    let st;
    try { st = fs.statSync(file); } catch { return next(); }
    if (!st.isFile() || st.size > MAX) return next();
    const key = `${st.mtimeMs}-${st.size}`;
    let e = cache.get(req.path);
    if (!e || e.key !== key) {
      try {
        e = { key, gz: zlib.gzipSync(fs.readFileSync(file), { level: 9 }), etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, mtime: st.mtime.toUTCString() };
      } catch { return next(); }
      cache.set(req.path, e);
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('ETag', e.etag);
    res.setHeader('Last-Modified', e.mtime);
    if (req.get('if-none-match') === e.etag) return res.status(304).end();
    res.setHeader('Content-Type', TYPES[path.extname(file)]);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', e.gz.length);
    if (req.method === 'HEAD') return res.end();
    res.end(e.gz);
  };
};
