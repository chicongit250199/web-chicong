'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();
const findUser = db.prepare('SELECT * FROM users WHERE username = ?');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { title: 'Đăng nhập', error: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút.', username: req.body.username || '', next: '' }),
});

function homeFor(user) { return user.role === 'manager' ? '/manager' : '/staff'; }
function safeNext(n) { return typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : ''; }

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('login', { title: 'Đăng nhập', error: null, username: '', next: safeNext(req.query.next) });
});

router.post('/login', loginLimiter, (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const u = findUser.get(username);
  const ok = u && bcrypt.compareSync(password, u.password_hash);
  if (!ok || !u.is_active) {
    return res.status(401).render('login', {
      title: 'Đăng nhập', username, next: safeNext(req.body.next),
      error: ok ? 'Tài khoản đã bị khóa.' : 'Sai tên đăng nhập hoặc mật khẩu.',
    });
  }
  // Tạo session mới khi đăng nhập (chống session fixation)
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = u.id;
    res.redirect(safeNext(req.body.next) || homeFor(u));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ccsid');
    res.redirect('/login');
  });
});

module.exports = router;
