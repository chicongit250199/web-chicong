'use strict';
// Doanh thu → Công nợ: danh sách người nợ (đối tác gộp chung), chi tiết, thu nợ, xóa lần trả
const express = require('express');
const debts = require('../../services/debts');

const router = express.Router();

router.get('/debts', (req, res) => {
  res.locals.nav = 'm-debts';
  const all = req.query.all === '1';
  const search = String(req.query.q || '').slice(0, 100);
  res.render('manager/debts', { title: 'Công nợ', list: debts.list({ all, search }), totals: debts.totals(), all, search });
});

router.get('/debts/view', (req, res, next) => {
  res.locals.nav = 'm-debts';
  const d = debts.detail(String(req.query.k || ''));
  if (!d) return next();
  res.render('manager/debt_detail', { title: `Công nợ: ${d.name || d.phone}`, d });
});

// Xóa 1 lần trả (nhập nhầm)
router.post('/debt-payments/:id/delete', (req, res) => {
  const back = typeof req.body.back === 'string' && /^\/(manager|staff)\//.test(req.body.back) ? req.body.back : '/manager/debts';
  try {
    const p = debts.deletePayment(Number(req.params.id));
    require('../../services/events').notify('revenue_deleted', `${req.user.full_name} xóa lần trả nợ ${require('../../services/format').money(p.amount)}`, back, req.user.full_name);
    req.flash('success', 'Đã xóa lần trả nợ.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(back);
});

module.exports = router;
