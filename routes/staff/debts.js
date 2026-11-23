'use strict';
// Thu nợ (nhân viên + quản lý): khách / đối tác trả tiền nợ tại quầy. Dùng ở trang Công nợ và Khách đối tác.
const express = require('express');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const debts = require('../../services/debts');
const { notify } = require('../../services/events');

const router = express.Router();
const schema = v.z.object({
  key: v.z.string().regex(/^[pcn]:.{1,120}$/, 'Không rõ người nợ'),
  amount: v.money.refine(x => x != null && x > 0, 'Nhập số tiền thu'),
  payment_method: v.oneOf(['cash', 'transfer'], 'Chọn hình thức thanh toán'),
  note: v.text(300),
});

router.post('/debts/pay', (req, res) => {
  const back = typeof req.body.back === 'string' && /^\/(manager|staff)\//.test(req.body.back) ? req.body.back : '/staff';
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect(back); }
  try {
    const d = debts.pay(data.key, data, req.user.full_name);
    notify('debt_payment', `${req.user.full_name} thu nợ ${d.name || d.phone}: ${fmt.money(data.amount)} (${fmt.payment(data.payment_method)}) — còn nợ ${fmt.money(d.balance)}`,
      `/manager/debts/view?k=${encodeURIComponent(data.key)}`, req.user.full_name, 'manager');
    req.flash('success', `Đã thu nợ ${fmt.money(data.amount)}. Còn nợ ${fmt.money(d.balance)}.`);
  } catch (e) { req.flash('error', e.message); }
  res.redirect(back);
});

module.exports = router;
