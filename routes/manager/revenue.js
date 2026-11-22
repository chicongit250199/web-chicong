'use strict';
const express = require('express');
const db = require('../../db');
const fmt = require('../../services/format');
const events = require('../../services/events');

const router = express.Router();
// Ngày theo giờ Việt Nam (UTC+7, không có giờ mùa hè)
const VN_DAY = `date(created_at, '+7 hours')`;

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function filters(query) {
  const today = fmt.todayYmd();
  const valid = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
  const group = ['day', 'month', 'year'].includes(query.group) ? query.group : 'day';
  const defFrom = group === 'year' ? addDays(today, -365 * 5) : group === 'month' ? today.slice(0, 4) + '-01-01' : addDays(today, -29);
  return {
    group,
    from: valid(query.from) || defFrom,
    to: valid(query.to) || today,
    type: ['repair', 'sale'].includes(query.type) ? query.type : '',
    payment: ['cash', 'transfer'].includes(query.payment) ? query.payment : '',
  };
}

function whereOf(f) {
  const w = [`${VN_DAY} BETWEEN @from AND @to`];
  if (f.type) w.push('type = @type');
  if (f.payment) w.push('payment_method = @payment');
  return 'WHERE ' + w.join(' AND ');
}

const SUMS = `COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
  COALESCE(SUM(CASE WHEN payment_method='cash' THEN amount END),0) AS cash,
  COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount END),0) AS transfer,
  COALESCE(SUM(CASE WHEN type='repair' THEN amount END),0) AS repair,
  COALESCE(SUM(CASE WHEN type='sale' THEN amount END),0) AS sale`;

function aggregate(f) {
  const period = { day: VN_DAY, month: `strftime('%Y-%m', created_at, '+7 hours')`, year: `strftime('%Y', created_at, '+7 hours')` }[f.group];
  const rows = db.prepare(`SELECT ${period} AS period, ${SUMS} FROM revenues ${whereOf(f)} GROUP BY period ORDER BY period`).all(f);
  // Điền các ngày không có doanh thu để biểu đồ liền mạch
  if (f.group === 'day') {
    const map = new Map(rows.map(r => [r.period, r]));
    const out = [];
    for (let d = f.from; d <= f.to && out.length < 400; d = addDays(d, 1)) {
      out.push(map.get(d) || { period: d, count: 0, total: 0, cash: 0, transfer: 0, repair: 0, sale: 0 });
    }
    return out;
  }
  return rows;
}

// Chi phí theo kỳ (chỉ lọc theo khoảng ngày)
function expenseByPeriod(f) {
  const period = { day: 'expense_date', month: 'substr(expense_date, 1, 7)', year: 'substr(expense_date, 1, 4)' }[f.group];
  return new Map(db.prepare(`SELECT ${period} AS p, COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY p`).all(f.from, f.to).map(r => [r.p, r.total]));
}

function periodLabel(p, group) {
  if (group === 'day') return `${p.slice(8, 10)}/${p.slice(5, 7)}`;
  if (group === 'month') return `${p.slice(5, 7)}/${p.slice(0, 4)}`;
  return p;
}

// ---------- Trang mặc định: doanh thu hôm nay ----------
router.get('/', (req, res) => {
  res.locals.nav = 'm-home';
  const today = fmt.todayYmd();
  const f = { group: 'day', from: addDays(today, -29), to: today, type: '', payment: '' };
  const todayStats = db.prepare(`SELECT ${SUMS} FROM revenues WHERE ${VN_DAY} = ?`).get(today);
  const yesterday = db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM revenues WHERE ${VN_DAY} = ?`).get(addDays(today, -1)).total;
  const month = db.prepare(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) count FROM revenues WHERE strftime('%Y-%m', created_at, '+7 hours') = ?`).get(today.slice(0, 7));
  const todayList = db.prepare(`SELECT * FROM revenues WHERE ${VN_DAY} = ? ORDER BY id DESC`).all(today);
  const taskCounts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) c FROM tasks WHERE status <> 'completed' GROUP BY status`).all().map(r => [r.status, r.c]));
  const rows = aggregate(f);
  res.render('manager/dashboard', {
    title: 'Doanh thu hôm nay', today, todayStats, yesterday, month, todayList, taskCounts,
    chart: rows.map(r => ({ label: periodLabel(r.period, 'day'), value: r.total, tip: `${fmt.date(r.period)}: ${fmt.money(r.total)} · ${r.count} giao dịch` })),
  });
});

// ---------- Thống kê theo Ngày / Tháng / Năm ----------
router.get('/revenue', (req, res) => {
  res.locals.nav = 'm-revenue';
  const f = filters(req.query);
  const rows = aggregate(f);
  const totals = db.prepare(`SELECT ${SUMS} FROM revenues ${whereOf(f)}`).get(f);
  const details = db.prepare(`SELECT * FROM revenues ${whereOf(f)} ORDER BY created_at DESC LIMIT 100`).all(f);
  const expMap = expenseByPeriod(f);
  for (const r of rows) r.expense = expMap.get(r.period) || 0;
  const expenseTotal = db.prepare('SELECT COALESCE(SUM(amount),0) t, COUNT(*) c FROM expenses WHERE expense_date BETWEEN ? AND ?').get(f.from, f.to);
  res.render('manager/revenue', {
    title: 'Thống kê doanh thu', f, rows, totals, details, expenseTotal,
    chart: rows.map(r => ({ label: periodLabel(r.period, f.group), value: r.total, tip: `${periodLabel(r.period, f.group)}: ${fmt.money(r.total)} · ${r.count} giao dịch` })),
    periodLabel,
  });
});

// Xuất CSV (mở bằng Excel)
router.get('/revenue.csv', (req, res) => {
  const f = filters(req.query);
  const rows = db.prepare(`SELECT * FROM revenues ${whereOf(f)} ORDER BY created_at`).all(f);
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [['Thời gian', 'Loại', 'Nội dung', 'Khách hàng', 'SĐT', 'Địa chỉ giao', 'Số tiền', 'Thanh toán', 'Bảo hành (tháng)', 'Nhân viên'].map(esc).join(',')];
  for (const r of rows) {
    lines.push([fmt.datetime(r.created_at), fmt.REVENUE_TYPE[r.type], r.content, r.customer_name, r.customer_phone, r.delivery_address, r.amount, fmt.payment(r.payment_method), r.warranty_months, r.staff_name].map(esc).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="doanh-thu-${f.from}-${f.to}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// ---------- Xóa doanh thu ----------
// Sửa chữa: xóa luôn máy đã trả (task + lịch sử). Bán hàng: trả món hàng về tồn kho.
router.post('/revenues/:id/delete', (req, res) => {
  const backTo = typeof req.body.back === 'string' && /^\/manager(\/|$|\?)/.test(req.body.back) ? req.body.back : '/manager/revenue';
  const r = db.prepare('SELECT * FROM revenues WHERE id = ?').get(req.params.id);
  if (!r) { req.flash('error', 'Không tìm thấy giao dịch.'); return res.redirect(backTo); }
  const result = db.transaction(() => {
    db.prepare('DELETE FROM revenues WHERE id = ?').run(r.id);
    if (r.type === 'repair' && r.ref_id) {
      const t = db.prepare('SELECT ticket_code FROM tasks WHERE id = ?').get(r.ref_id);
      db.prepare(`DELETE FROM revenues WHERE type = 'repair' AND ref_id = ?`).run(r.ref_id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(r.ref_id);
      return t ? `và máy đã trả ${t.ticket_code}` : '';
    }
    if (r.type === 'sale' && r.ref_id) {
      const u = db.prepare(`UPDATE inventory_items SET status = 'in_stock', sold_date = NULL, customer_name = NULL, customer_phone = NULL
                            WHERE id = ? AND status = 'sold'`).run(r.ref_id);
      return u.changes ? '— món hàng đã quay lại tồn kho' : '';
    }
    return '';
  })();
  events.notify('revenue_deleted', `${req.user.full_name} xóa doanh thu ${fmt.money(r.amount)}: ${r.content || ''}`.slice(0, 300), null, req.user.full_name);
  req.flash('success', `Đã xóa doanh thu ${fmt.money(r.amount)} ${result}`.trim() + '.');
  res.redirect(backTo);
});

// ---------- Thông báo real-time ----------
router.get('/events', events.stream);
router.get('/notifications.json', (req, res) => res.json(require('../../middleware/appShell').notifData(req.user)));
router.post('/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
  res.json({ ok: true });
});

module.exports = router;
