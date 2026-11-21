'use strict';
// Import doanh thu từ file Excel cũ: upload -> xem trước (theo tháng) -> xác nhận; quản lý / xóa từng đợt nhập
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const fmt = require('../../services/format');
const { fileUpload } = require('../../services/upload');
const { parseRevenueWorkbook } = require('../../services/revenueImport');
const { notify } = require('../../services/events');

const router = express.Router();
const TMP = path.join(path.dirname(config.dbPath), 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const safe = t => String(t || '').replace(/[^a-f0-9]/g, '');
const xlsxPath = t => path.join(TMP, `rev-${safe(t)}.xlsx`);
const metaPath = t => path.join(TMP, `rev-${safe(t)}.json`);

function loadPreview(req) {
  const t = req.session.revImport;
  if (!t || !fs.existsSync(xlsxPath(t)) || !fs.existsSync(metaPath(t))) return null;
  return JSON.parse(fs.readFileSync(metaPath(t), 'utf8'));
}

// Đọc file 1 lần (lúc tải lên / đổi đơn vị) rồi lưu kết quả, các lần xem / lọc sau dùng lại
function parseAndStore(t, fileName, unit) {
  const parsed = parseRevenueWorkbook(fs.readFileSync(xlsxPath(t)), { unit });
  fs.writeFileSync(metaPath(t), JSON.stringify({ fileName, unit, ...parsed }));
  return parsed;
}

function cleanup(req) {
  const t = req.session.revImport;
  if (t) { fs.rmSync(xlsxPath(t), { force: true }); fs.rmSync(metaPath(t), { force: true }); }
  delete req.session.revImport;
}

const ok = r => !r.duplicate && !r.problem;

router.get('/import/revenue', (req, res) => {
  res.locals.nav = 'm-import';
  const data = loadPreview(req);
  const batches = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM revenues r WHERE r.import_batch = b.id) AS remaining
                              FROM import_batches b WHERE kind = 'revenue' ORDER BY created_at DESC`).all();
  let view = null;
  if (data) {
    const good = data.rows.filter(ok);
    const months = new Map();
    for (const r of good) {
      const m = r.date.slice(0, 7);
      const x = months.get(m) || { month: m, count: 0, total: 0, repair: 0, sale: 0, transfer: 0 };
      x.count++; x.total += r.amount; x[r.type] += r.amount; if (r.payment === 'transfer') x.transfer += r.amount;
      months.set(m, x);
    }
    const filter = ['repair', 'sale', 'duplicate', 'problem', 'transfer'].includes(req.query.show) ? req.query.show : 'all';
    let rows = data.rows;
    if (filter === 'duplicate') rows = rows.filter(r => r.duplicate);
    else if (filter === 'problem') rows = rows.filter(r => r.problem);
    else if (filter === 'transfer') rows = rows.filter(r => ok(r) && r.payment === 'transfer');
    else if (filter !== 'all') rows = rows.filter(r => ok(r) && r.type === filter);
    view = {
      fileName: data.fileName, unit: data.unit, factor: data.factor, warnings: data.warnings, expense: data.expense, sheets: data.sheetsUsed,
      noContent: data.noContent || { count: 0, total: 0 },
      total: data.rows.length, good: good.length, sum: good.reduce((s, r) => s + r.amount, 0),
      repair: good.filter(r => r.type === 'repair').length, sale: good.filter(r => r.type === 'sale').length,
      transfer: good.filter(r => r.payment === 'transfer').length,
      duplicate: data.rows.filter(r => r.duplicate).length, problem: data.rows.filter(r => r.problem).length,
      dateFrom: good.length ? good.reduce((a, r) => (r.date < a ? r.date : a), good[0].date) : null,
      dateTo: good.length ? good.reduce((a, r) => (r.date > a ? r.date : a), good[0].date) : null,
      months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
      filter, rows: rows.slice(-300).reverse(), shown: rows.length,
    };
  }
  res.render('manager/import_revenue', { title: 'Import doanh thu', view, batches });
});

router.post('/import/revenue', fileUpload(25).single('file'), (req, res) => {
  if (!req.file) { req.flash('error', 'Chọn file Excel doanh thu (.xlsx / .xls).'); return res.redirect('/manager/import/revenue'); }
  if (!/\.(xlsx|xls|xlsm)$/i.test(req.file.originalname)) { req.flash('error', 'Chỉ nhận file .xlsx, .xls, .xlsm'); return res.redirect('/manager/import/revenue'); }
  cleanup(req);
  const t = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(xlsxPath(t), req.file.buffer);
  let parsed;
  try { parsed = parseAndStore(t, Buffer.from(req.file.originalname, 'latin1').toString('utf8'), 'auto'); } catch (e) {
    fs.rmSync(xlsxPath(t), { force: true });
    req.flash('error', `Không đọc được file: ${e.message}`); return res.redirect('/manager/import/revenue');
  }
  if (!parsed.rows.length) {
    fs.rmSync(xlsxPath(t), { force: true }); fs.rmSync(metaPath(t), { force: true });
    req.flash('error', ['Không tìm thấy dòng doanh thu nào.', ...parsed.warnings].join(' ')); return res.redirect('/manager/import/revenue');
  }
  req.session.revImport = t;
  res.redirect('/manager/import/revenue');
});

// Đổi đơn vị tiền nếu tự nhận diện sai
router.post('/import/revenue/unit', (req, res) => {
  const t = req.session.revImport;
  if (t && fs.existsSync(metaPath(t))) {
    const meta = JSON.parse(fs.readFileSync(metaPath(t), 'utf8'));
    parseAndStore(t, meta.fileName, ['thousand', 'vnd', 'auto'].includes(req.body.unit) ? req.body.unit : 'auto');
  }
  res.redirect('/manager/import/revenue');
});

router.post('/import/revenue/confirm', (req, res) => {
  const data = loadPreview(req);
  if (!data) { req.flash('error', 'Phiên xem trước đã hết, hãy tải file lên lại.'); return res.redirect('/manager/import/revenue'); }
  const good = data.rows.filter(ok);
  if (!good.length) { req.flash('error', 'Không có dòng hợp lệ để nhập.'); return res.redirect('/manager/import/revenue'); }
  const batch = 'XL' + fmt.todayYmd().replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex');
  const ins = db.prepare(`INSERT INTO revenues (type, customer_name, customer_phone, content, amount, payment_method, staff_name, created_at, source, import_batch)
                          VALUES (?, ?, ?, ?, ?, ?, 'Nhập từ Excel', ?, 'excel', ?)`);
  const sum = good.reduce((s, r) => s + r.amount, 0);
  const dates = good.map(r => r.date).sort();
  db.transaction(() => {
    for (const r of good) {
      // 12:00 trưa giờ VN để luôn rơi đúng ngày khi thống kê
      ins.run(r.type, r.customer, r.phone, r.saveContent, r.amount, r.payment, `${r.date}T05:00:00.000Z`, batch);
    }
    db.prepare(`INSERT INTO import_batches (id, kind, file_name, row_count, total, date_from, date_to, user_name) VALUES (?, 'revenue', ?, ?, ?, ?, ?, ?)`)
      .run(batch, data.fileName, good.length, sum, dates[0], dates[dates.length - 1], req.user.full_name);
  })();
  cleanup(req);
  notify('inventory', `${req.user.full_name} nhập doanh thu từ Excel: ${good.length} giao dịch, ${fmt.money(sum)} (${fmt.date(dates[0])} – ${fmt.date(dates[dates.length - 1])})`, '/manager/revenue?group=month', req.user.full_name);
  req.flash('success', `Đã nhập ${good.length} giao dịch, tổng ${fmt.money(sum)} (đợt ${batch}).`);
  res.redirect('/manager/import/revenue');
});

router.post('/import/revenue/cancel', (req, res) => { cleanup(req); res.redirect('/manager/import/revenue'); });

// Xóa cả một đợt nhập (khi nhập nhầm file / sai đơn vị)
router.post('/import/revenue/batches/:id/delete', (req, res) => {
  const b = db.prepare(`SELECT * FROM import_batches WHERE id = ? AND kind = 'revenue'`).get(req.params.id);
  if (!b) { req.flash('error', 'Không tìm thấy đợt nhập.'); return res.redirect('/manager/import/revenue'); }
  const n = db.transaction(() => {
    const r = db.prepare('DELETE FROM revenues WHERE import_batch = ?').run(b.id);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(b.id);
    return r.changes;
  })();
  notify('revenue_deleted', `${req.user.full_name} xóa đợt nhập doanh thu ${b.id} (${n} giao dịch)`, null, req.user.full_name);
  req.flash('success', `Đã xóa đợt ${b.id}: ${n} giao dịch.`);
  res.redirect('/manager/import/revenue');
});

module.exports = router;
