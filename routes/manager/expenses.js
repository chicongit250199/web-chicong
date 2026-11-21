'use strict';
// Chi phí: danh sách, thêm tay, xóa. (Nhập hàng loạt từ cột CHI của file doanh thu ở Import Excel)
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const { notify } = require('../../services/events');

const router = express.Router();
const PAGE = 20;

function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

router.get('/expenses', (req, res) => {
  res.locals.nav = 'm-expenses';
  const today = fmt.todayYmd();
  const valid = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
  const from = valid(req.query.from) || today.slice(0, 7) + '-01';
  const to = valid(req.query.to) || today;
  const q = String(req.query.q || '').trim();
  const where = ['expense_date BETWEEN @from AND @to'];
  if (q) where.push('(vn(content) LIKE @q OR vn(note) LIKE @q)');
  const params = { from, to, q: `%${db.vn(q)}%` };
  const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) total,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN amount END),0) cash,
      COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount END),0) transfer FROM expenses WHERE ${where.join(' AND ')}`).get(params);
  const income = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM revenues WHERE date(created_at, '+7 hours') BETWEEN ? AND ?`).get(from, to).t;
  const pages = Math.max(1, Math.ceil(agg.c / PAGE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const rows = db.prepare(`SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY expense_date DESC, id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).all(params);
  res.render('manager/expenses', { title: 'Chi phí', rows, agg, income, from, to, q, page, pages, today, presets: {
    'Tháng này': [today.slice(0, 7) + '-01', today],
    '30 ngày': [addDays(today, -29), today],
    'Năm nay': [today.slice(0, 4) + '-01-01', today],
    'Tất cả': ['2000-01-01', today],
  } });
});

const schema = v.z.object({
  expense_date: v.z.preprocess(x => x || fmt.todayYmd(), v.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ')),
  content: v.reqText('Nhập nội dung chi', 500),
  amount: v.money.refine(x => x != null && x > 0, 'Nhập số tiền chi'),
  payment_method: v.oneOf(['cash', 'transfer'], 'Chọn hình thức'),
  note: v.text(500),
});

router.post('/expenses', (req, res) => {
  const back = typeof req.body.back === 'string' && /^\/manager\/expenses(\?|$)/.test(req.body.back) ? req.body.back : '/manager/expenses';
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect(back); }
  db.prepare('INSERT INTO expenses (expense_date, content, amount, payment_method, note, staff_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(data.expense_date, data.content, data.amount, data.payment_method, data.note, req.user.full_name);
  req.flash('success', `Đã ghi chi phí "${data.content}" — ${fmt.money(data.amount)}.`);
  res.redirect(back);
});

router.post('/expenses/:id/delete', (req, res) => {
  const back = typeof req.body.back === 'string' && /^\/manager\/expenses(\?|$)/.test(req.body.back) ? req.body.back : '/manager/expenses';
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (e) {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
    notify('revenue_deleted', `${req.user.full_name} xóa chi phí ${fmt.money(e.amount)}: ${e.content}`.slice(0, 300), '/manager/expenses', req.user.full_name);
    req.flash('success', `Đã xóa chi phí "${e.content}".`);
  }
  res.redirect(back);
});

module.exports = router;
