'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const v = require('../../services/validate');

const router = express.Router();

const q = {
  list: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status IN ('pending','processing')) AS open_tasks
                    FROM users u ORDER BY u.role DESC, u.is_active DESC, u.full_name`),
  get: db.prepare('SELECT * FROM users WHERE id = ?'),
  activeManagers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'manager' AND is_active = 1 AND id <> ?`),
};

const createSchema = v.z.object({
  username: v.z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/, 'Tên đăng nhập 3-32 ký tự: chữ không dấu, số, . _ -'),
  full_name: v.reqText('Nhập họ tên', 100),
  password: v.z.string().min(6, 'Mật khẩu tối thiểu 6 ký tự').max(100),
  role: v.oneOf(['staff', 'manager'], 'Chọn vai trò'),
});

router.get('/users', (req, res) => {
  res.locals.nav = 'm-users'; // tab trong trang Hệ thống
  res.render('manager/users', { title: 'Tài khoản nhân viên', users: q.list.all(), scripts: ['/js/zalo.js'],
    zaloPartners: db.prepare('SELECT id, name, zalo_name FROM partners WHERE zalo_chat_id IS NOT NULL ORDER BY name COLLATE NOCASE').all() });
});

router.post('/users', (req, res) => {
  const { data, error } = v.parse(createSchema, req.body);
  if (error) { req.flash('error', error); return res.redirect('/manager/users'); }
  try {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
      .run(data.username, bcrypt.hashSync(data.password, 10), data.full_name, data.role);
    req.flash('success', `Đã tạo tài khoản ${data.username}.`);
  } catch (e) {
    req.flash('error', /UNIQUE/.test(e.message) ? 'Tên đăng nhập đã tồn tại.' : e.message);
  }
  res.redirect('/manager/users');
});

// Một manager luôn phải còn hoạt động; không tự khóa/xóa/hạ quyền chính mình
function guard(req, target, action) {
  if (!target) return 'Không tìm thấy tài khoản.';
  if (target.id === req.user.id && ['lock', 'delete', 'demote'].includes(action)) return 'Không thể thực hiện thao tác này với chính tài khoản của bạn.';
  if (target.role === 'manager' && ['lock', 'delete', 'demote'].includes(action) && q.activeManagers.get(target.id).c === 0) return 'Phải còn ít nhất 1 tài khoản Quản lý đang hoạt động.';
  return null;
}

router.post('/users/:id', (req, res) => {
  const target = q.get.get(req.params.id);
  const { data, error } = v.parse(v.z.object({ full_name: v.reqText('Nhập họ tên', 100), role: v.oneOf(['staff', 'manager']) }), req.body);
  const err = error || guard(req, target, target && target.role === 'manager' && data && data.role === 'staff' ? 'demote' : 'edit');
  if (err) { req.flash('error', err); return res.redirect('/manager/users'); }
  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(data.full_name, data.role, target.id);
  req.flash('success', `Đã cập nhật ${target.username}.`);
  res.redirect('/manager/users');
});

router.post('/users/:id/password', (req, res) => {
  const target = q.get.get(req.params.id);
  const pw = String(req.body.password || '');
  if (!target) { req.flash('error', 'Không tìm thấy tài khoản.'); return res.redirect('/manager/users'); }
  if (pw.length < 6) { req.flash('error', 'Mật khẩu tối thiểu 6 ký tự.'); return res.redirect('/manager/users'); }
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), target.id);
    // Đăng xuất mọi phiên của tài khoản đó (trừ phiên hiện tại)
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid <> ?`).run(target.id, req.sessionID);
  })();
  req.flash('success', `Đã đổi mật khẩu cho ${target.username}.`);
  res.redirect('/manager/users');
});

router.post('/users/:id/toggle', (req, res) => {
  const target = q.get.get(req.params.id);
  const err = guard(req, target, target && target.is_active ? 'lock' : 'unlock');
  if (err) { req.flash('error', err); return res.redirect('/manager/users'); }
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(target.is_active ? 0 : 1, target.id);
  req.flash('success', `${target.is_active ? 'Đã khóa' : 'Đã mở khóa'} ${target.username}.`);
  res.redirect('/manager/users');
});

router.post('/users/:id/delete', (req, res) => {
  const target = q.get.get(req.params.id);
  const err = guard(req, target, 'delete');
  if (err) { req.flash('error', err); return res.redirect('/manager/users'); }
  db.transaction(() => {
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id); // task/sản phẩm giữ nguyên (khóa ngoại SET NULL), tên KTV vẫn lưu trong task
  })();
  req.flash('success', `Đã xóa ${target.username}.`);
  res.redirect('/manager/users');
});

// ---------- Thông báo Zalo ----------
const zalo = require('../../services/zaloBot');
const zj = fn => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await fn(req)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};
router.get('/users/zalo/status', zj(() => zalo.status()));
router.post('/users/zalo/send', zj(req => zalo.sendCustom(req.body.target, req.body.text)));
require('../../services/zaloRoutes')(router, '/users', 'user');

module.exports = router;
