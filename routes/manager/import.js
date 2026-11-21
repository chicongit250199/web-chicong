'use strict';
// Import Kho hàng thường từ file Excel cũ: upload -> preview -> xác nhận
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const { fileUpload } = require('../../services/upload');
const { parseWorkbook } = require('../../services/excelImport');
const { notify } = require('../../services/events');

const router = express.Router();
const TMP = path.join(path.dirname(config.dbPath), 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const tmpFile = token => path.join(TMP, `import-${token.replace(/[^a-f0-9]/g, '')}.json`);

function load(req) {
  const token = req.session.importToken;
  if (!token || !fs.existsSync(tmpFile(token))) return null;
  return JSON.parse(fs.readFileSync(tmpFile(token), 'utf8'));
}

router.get('/import', (req, res) => {
  res.locals.nav = 'm-import';
  const data = load(req);
  const filter = ['in_stock', 'sold', 'duplicate', 'hint'].includes(req.query.show) ? req.query.show : 'all';
  let rows = data ? data.rows : [];
  const summary = data && {
    total: rows.length,
    in_stock: rows.filter(r => r.status === 'in_stock' && !r.duplicate).length,
    sold: rows.filter(r => r.status === 'sold' && !r.duplicate).length,
    duplicate: rows.filter(r => r.duplicate).length,
  };
  if (filter === 'duplicate') rows = rows.filter(r => r.duplicate);
  else if (filter === 'hint') rows = rows.filter(r => r.hint && !r.duplicate);
  else if (filter !== 'all') rows = rows.filter(r => r.status === filter && !r.duplicate);
  const batches = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM inventory_items i WHERE i.import_batch = b.id) AS remaining
                              FROM import_batches b WHERE kind = 'inventory' ORDER BY created_at DESC`).all();
  res.render('manager/import', { title: 'Import Excel kho', data, summary, rows: rows.slice(0, 500), shown: rows.length, filter, batches });
});

router.post('/import', fileUpload(15).single('file'), (req, res) => {
  if (!req.file) { req.flash('error', 'Chọn file Excel (.xlsx / .xls).'); return res.redirect('/manager/import'); }
  if (!/\.(xlsx|xls|xlsm|csv)$/i.test(req.file.originalname)) { req.flash('error', 'Chỉ nhận file .xlsx, .xls, .xlsm, .csv'); return res.redirect('/manager/import'); }
  let parsed;
  try { parsed = parseWorkbook(req.file.buffer); } catch (e) {
    req.flash('error', `Không đọc được file: ${e.message}`); return res.redirect('/manager/import');
  }
  if (!parsed.rows.length) { req.flash('error', ['Không tìm thấy dòng dữ liệu nào.', ...parsed.warnings].join(' ')); return res.redirect('/manager/import'); }
  if (req.session.importToken) fs.rmSync(tmpFile(req.session.importToken), { force: true });
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(tmpFile(token), JSON.stringify({ fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), warnings: parsed.warnings, rows: parsed.rows }));
  req.session.importToken = token;
  res.redirect('/manager/import');
});

router.post('/import/confirm', (req, res) => {
  const data = load(req);
  if (!data) { req.flash('error', 'Phiên xem trước đã hết, hãy tải file lên lại.'); return res.redirect('/manager/import'); }
  const ins = db.prepare(`INSERT OR IGNORE INTO inventory_items (item_code, name, serial, import_date, condition, supplier, warranty_in_months, tech_price, retail_price,
      status, sold_date, customer_name, customer_phone, warranty_out_months, note, import_batch)
      VALUES (@item_code, @name, @serial, @import_date, @condition, @supplier, @warranty_in_months, @tech_price, @retail_price,
      @status, @sold_date, @customer_name, @customer_phone, @warranty_out_months, @note, @import_batch)`);
  const batch = 'KHO' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex');
  const counts = db.transaction(() => {
    const c = { in_stock: 0, sold: 0, skipped: 0 };
    const dates = [];
    for (const r of data.rows) {
      if (r.duplicate) { c.skipped++; continue; }
      const { changes } = ins.run({ ...r, import_batch: batch });
      if (changes) { c[r.status]++; if (r.import_date) dates.push(r.import_date); } else c.skipped++;
    }
    dates.sort();
    db.prepare(`INSERT INTO import_batches (id, kind, file_name, row_count, total, date_from, date_to, user_name) VALUES (?, 'inventory', ?, ?, ?, ?, ?, ?)`)
      .run(batch, data.fileName, c.in_stock + c.sold, c.sold, dates[0] || null, dates[dates.length - 1] || null, req.user.full_name);
    return c;
  })();
  fs.rmSync(tmpFile(req.session.importToken), { force: true });
  delete req.session.importToken;
  notify('inventory', `${req.user.full_name} import Excel "${data.fileName}": ${counts.in_stock} tồn kho, ${counts.sold} đã bán`, '/staff/inventory', req.user.full_name);
  req.flash('success', `Đã import (đợt ${batch}): ${counts.in_stock} món tồn kho, ${counts.sold} món đã bán${counts.skipped ? `, bỏ qua ${counts.skipped} dòng trùng Serial` : ''}.`);
  res.redirect('/staff/inventory');
});

// Xóa cả một đợt import kho (để import lại)
router.post('/import/batches/:id/delete', (req, res) => {
  const b = db.prepare(`SELECT * FROM import_batches WHERE id = ? AND kind = 'inventory'`).get(req.params.id);
  if (!b) { req.flash('error', 'Không tìm thấy đợt import.'); return res.redirect('/manager/import'); }
  const n = db.transaction(() => {
    const r = db.prepare('DELETE FROM inventory_items WHERE import_batch = ?').run(b.id);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(b.id);
    return r.changes;
  })();
  notify('revenue_deleted', `${req.user.full_name} xóa đợt import kho ${b.id} (${n} món)`, '/staff/inventory', req.user.full_name);
  req.flash('success', `Đã xóa đợt ${b.id}: ${n} món khỏi kho. Có thể import lại.`);
  res.redirect('/manager/import');
});

router.post('/import/cancel', (req, res) => {
  if (req.session.importToken) fs.rmSync(tmpFile(req.session.importToken), { force: true });
  delete req.session.importToken;
  res.redirect('/manager/import');
});

module.exports = router;
