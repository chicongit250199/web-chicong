'use strict';
// CSRF dạng synchronizer token lưu trong session.
// Form: <input type="hidden" name="_csrf" value="<%= csrfToken %>">
// fetch(): header 'X-CSRF-Token' (lấy từ <meta name="csrf-token">)
const crypto = require('crypto');

const SAFE = ['GET', 'HEAD', 'OPTIONS'];

function csrf(req, res, next) {
  // Khách vãng lai xem trang chủ: không tạo session/token (tránh ghi DB cho mỗi lượt xem)
  if (!req.session.csrf && (req.user || !SAFE.includes(req.method) || req.path === '/login')) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrf || '';
  if (SAFE.includes(req.method)) return next();
  if (!req.session.csrf) return reject(req, res);

  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf) || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  reject(req, res);
}

function reject(req, res) {
  res.status(403);
  if (req.xhr || (req.get('accept') || '').includes('json')) return res.json({ error: 'Phiên làm việc hết hạn, hãy tải lại trang.' });
  res.render('error', { title: '403', message: 'Phiên làm việc hết hạn, hãy tải lại trang và thử lại.' });
}

module.exports = csrf;
