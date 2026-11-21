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
  res.render('manager/import', { title: 'Import Excel kho', data, summary, rows: rows.slice(0, 500), shown: rows.length, filter });
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
  fs.writeFileSync(tmpFile(token), JSON.stringify({ fileName: req.file.originalname, warnings: parsed.warnings, rows: parsed.rows }));
  req.session.importToken = token;
  res.redirect('/manager/import');
});

router.post('/import/confirm', (req, res) => {
  const data = load(req);
  if (!data) { req.flash('error', 'Phiên xem trước đã hết, hãy tải file lên lại.'); return res.redirect('/manager/import'); }
  const ins = db.prepare(`INSERT OR IGNORE INTO inventory_items (item_code, name, serial, import_date, condition, supplier, warranty_in_months, tech_price, retail_price,
      status, sold_date, customer_name, customer_phone, warranty_out_months, note)
      VALUES (@item_code, @name, @serial, @import_date, @condition, @supplier, @warranty_in_months, @tech_price, @retail_price,
      @status, @sold_date, @customer_name, @customer_phone, @warranty_out_months, @note)`);
  const counts = db.transaction(() => {
    const c = { in_stock: 0, sold: 0, skipped: 0 };
    for (const r of data.rows) {
      if (r.duplicate) { c.skipped++; continue; }
      const { changes } = ins.run(r);
      if (changes) c[r.status]++; else c.skipped++;
    }
    return c;
  })();
  fs.rmSync(tmpFile(req.session.importToken), { force: true });
  delete req.session.importToken;
  notify('inventory', `${req.user.full_name} import Excel "${data.fileName}": ${counts.in_stock} tồn kho, ${counts.sold} đã bán`, '/staff/inventory', req.user.full_name);
  req.flash('success', `Đã import: ${counts.in_stock} món tồn kho, ${counts.sold} món đã bán${counts.skipped ? `, bỏ qua ${counts.skipped} dòng trùng Serial` : ''}.`);
  res.redirect('/staff/inventory');
});

router.post('/import/cancel', (req, res) => {
  if (req.session.importToken) fs.rmSync(tmpFile(req.session.importToken), { force: true });
  delete req.session.importToken;
  res.redirect('/manager/import');
});

module.exports = router;
