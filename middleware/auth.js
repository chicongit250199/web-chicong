'use strict';
const db = require('../db');

const getUser = db.prepare('SELECT id, username, full_name, role, is_active FROM users WHERE id = ?');

// Nạp user từ DB mỗi request: khóa tài khoản / đổi quyền có hiệu lực ngay
function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  if (id) {
    const u = getUser.get(id);
    if (u && u.is_active) req.user = u;
    else req.session.userId = null;
  }
  res.locals.user = req.user || null;
  next();
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json') || req.path.startsWith('/api');
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// Manager có toàn quyền nghiệp vụ của Staff
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.role === role || (role === 'staff' && req.user.role === 'manager')) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'Không có quyền' });
    res.status(403).render('error', { title: '403', message: 'Bạn không có quyền truy cập trang này.' });
  };
}

module.exports = { loadUser, requireAuth, requireRole, wantsJson };
