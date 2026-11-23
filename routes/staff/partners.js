'use strict';
// Khách đối tác: mỗi đối tác 1 tab — máy đang sửa / chờ trả / đã trả, tiền theo tháng. Quản lý thêm / sửa / xóa đối tác.
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const partners = require('../../services/partners');

const router = express.Router();
const nav = (req, res, next) => { res.locals.nav = 'partners'; next(); };
const managerOnly = (req, res, next) => {
  if (req.user.role === 'manager') return next();
  req.flash('error', 'Chỉ quản lý được sửa danh sách đối tác.');
  res.redirect('/staff/partners');
};
const VN_MONTH = col => `strftime('%Y-%m', ${col}, '+7 hours')`;

router.get('/partners', nav, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : fmt.todayYmd().slice(0, 7);
  const list = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.partner_id = p.id AND t.status IN ('pending','processing')) AS open,
      (SELECT COUNT(*) FROM tasks t WHERE t.partner_id = p.id AND t.status IN ('done','unrepairable')) AS ready,
      (SELECT COUNT(*) FROM tasks t WHERE t.partner_id = p.id AND t.status = 'completed' AND ${VN_MONTH('t.completed_at')} = @m) AS done_month,
      (SELECT COUNT(*) FROM tasks t WHERE t.partner_id = p.id) AS total,
      (SELECT COALESCE(SUM(r.amount),0) FROM revenues r JOIN tasks t ON r.type = 'repair' AND r.ref_id = t.id WHERE t.partner_id = p.id AND ${VN_MONTH('r.created_at')} = @m) AS money_month
    FROM partners p ORDER BY p.name COLLATE NOCASE`).all({ m: month });

  const sel = req.query.p ? list.find(p => String(p.id) === String(req.query.p)) : null;
  let tasks = []; let filter = 'open';
  if (sel) {
    filter = ['open', 'ready', 'completed', 'all'].includes(req.query.s) ? req.query.s : 'open';
    const where = { open: `t.status IN ('pending','processing')`, ready: `t.status IN ('done','unrepairable')`,
      completed: `t.status = 'completed' AND ${VN_MONTH('t.completed_at')} = @m`, all: '1=1' }[filter];
    tasks = db.prepare(`SELECT t.*, u.full_name AS assigned_name,
        (SELECT COALESCE(SUM(amount),0) FROM revenues r WHERE r.type = 'repair' AND r.ref_id = t.id) AS paid
        FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.partner_id = @p AND ${where} ORDER BY t.created_at DESC LIMIT 300`).all({ p: sel.id, m: month });
  }
  res.render('staff/partners', {
    title: sel ? `Đối tác: ${sel.name}` : 'Khách đối tác', list, sel, tasks, filter, month,
    suggestions: !sel && req.user.role === 'manager' ? partners.suggestions() : [],
    canEdit: req.user.role === 'manager',
    scripts: req.user.role === 'manager' ? ['/js/zalo.js'] : [],
  });
});

const schema = v.z.object({
  name: v.reqText('Nhập tên đối tác', 120),
  aliases: v.text(1000),
  phones: v.text(500),
  note: v.text(1000),
});

router.post('/partners', managerOnly, (req, res) => {
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect('/staff/partners'); }
  if (partners.squash(data.name).length < 3) { req.flash('error', 'Tên đối tác quá ngắn (tối thiểu 3 ký tự chữ/số).'); return res.redirect('/staff/partners'); }
  const dup = db.prepare('SELECT id, name FROM partners').all().find(p => partners.squash(p.name) === partners.squash(data.name));
  if (dup) { req.flash('error', `Đã có đối tác "${dup.name}".`); return res.redirect(`/staff/partners?p=${dup.id}`); }
  const id = db.prepare('INSERT INTO partners (name, aliases, phones, note) VALUES (@name, @aliases, @phones, @note)').run(data).lastInsertRowid;
  const n = partners.reclassify();
  req.flash('success', `Đã thêm đối tác "${data.name}"${n ? ` — xếp ${n} task vào đối tác` : ''}.`);
  res.redirect(`/staff/partners?p=${id}&s=all`);
});

router.post('/partners/:id', managerOnly, (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect(`/staff/partners?p=${req.params.id}`); }
  db.prepare('UPDATE partners SET name=@name, aliases=@aliases, phones=@phones, note=@note WHERE id=@id').run({ ...data, id: req.params.id });
  const n = partners.reclassify();
  req.flash('success', `Đã lưu "${data.name}"${n ? ` — cập nhật phân loại ${n} task` : ''}.`);
  res.redirect(`/staff/partners?p=${req.params.id}`);
});

router.post('/partners/:id/delete', managerOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (p) { db.prepare('DELETE FROM partners WHERE id = ?').run(p.id); partners.reclassify(); }
  req.flash('success', p ? `Đã xóa đối tác "${p.name}" (task vẫn giữ nguyên, chỉ bỏ phân loại).` : 'Đối tác không còn.');
  res.redirect('/staff/partners');
});

// Nhóm Zalo của đối tác (quản lý liên kết)
const managerJson = (req, res, next) => (req.user.role === 'manager' ? next() : res.status(403).json({ error: 'Chỉ quản lý' }));
require('../../services/zaloRoutes')(router, '/partners', 'partner', managerJson);

module.exports = router;
