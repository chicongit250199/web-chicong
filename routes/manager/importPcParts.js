'use strict';
// Import báo giá linh kiện (Build PC) từ Excel: upload -> xem trước thay đổi -> xác nhận (cập nhật, không xóa sạch)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const pc = require('../../services/pcParts');
const { fileUpload } = require('../../services/upload');
const { notify } = require('../../services/events');

const router = express.Router();
const TMP = path.join(path.dirname(config.dbPath), 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const tmpFile = token => path.join(TMP, `pcparts-${token.replace(/[^a-f0-9]/g, '')}.json`);
const nav = (req, res, next) => { res.locals.nav = 'm-import'; next(); };

function load(req) {
  const token = req.session.pcImportToken;
  if (!token || !fs.existsSync(tmpFile(token))) return null;
  return JSON.parse(fs.readFileSync(tmpFile(token), 'utf8'));
}

const FIELDS = ['price', 'warranty_months', 'note', 'note_public', 'category', 'name', 'condition'];

// So sánh file với dữ liệu hiện có
function diff(rows) {
  const existing = new Map(db.prepare('SELECT * FROM pc_parts').all().map(p => [p.match_key, p]));
  const out = { added: [], changed: [], same: 0, missing: [] };
  const inFile = new Set();
  for (const r of rows) {
    inFile.add(r.match_key);
    const cur = existing.get(r.match_key);
    if (!cur) { out.added.push(r); continue; }
    const changes = FIELDS.filter(f => (cur[f] ?? null) !== (r[f] ?? null)).map(f => ({ field: f, from: cur[f], to: r[f] }));
    if (changes.length) out.changed.push({ ...r, id: cur.id, changes }); else out.same++;
  }
  for (const [k, p] of existing) if (!inFile.has(k)) out.missing.push(p);
  return out;
}

router.get('/import/pc-parts', nav, (req, res) => {
  const data = load(req);
  const d = data ? diff(data.rows) : null;
  const batches = db.prepare(`SELECT * FROM import_batches WHERE kind = 'pc_parts' ORDER BY created_at DESC LIMIT 10`).all();
  const count = db.prepare('SELECT COUNT(*) n FROM pc_parts').get().n;
  res.render('manager/import_pc_parts', { title: 'Import báo giá linh kiện', data, d, batches, count });
});

router.post('/import/pc-parts', fileUpload(15).single('file'), (req, res) => {
  const back = '/manager/import/pc-parts';
  if (!req.file) { req.flash('error', 'Chọn file Excel (.xlsx / .xls).'); return res.redirect(back); }
  if (!/\.(xlsx|xls|xlsm)$/i.test(req.file.originalname)) { req.flash('error', 'Chỉ nhận file .xlsx, .xls, .xlsm'); return res.redirect(back); }
  let parsed;
  try { parsed = pc.parsePriceWorkbook(req.file.buffer); } catch (e) { req.flash('error', `Không đọc được file: ${e.message}`); return res.redirect(back); }
  if (!parsed.rows.length) { req.flash('error', 'Không có dòng linh kiện nào.'); return res.redirect(back); }
  if (req.session.pcImportToken) fs.rmSync(tmpFile(req.session.pcImportToken), { force: true });
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(tmpFile(token), JSON.stringify({ fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), sheet: parsed.sheet, warnings: parsed.warnings, rows: parsed.rows }));
  req.session.pcImportToken = token;
  res.redirect(back);
});

router.post('/import/pc-parts/confirm', (req, res) => {
  const data = load(req);
  if (!data) { req.flash('error', 'Phiên xem trước đã hết, hãy tải file lên lại.'); return res.redirect('/manager/import/pc-parts'); }
  const d = diff(data.rows);
  const remove = new Set([].concat(req.body.remove || []).map(Number));
  const ins = db.prepare(`INSERT INTO pc_parts (category, name, condition, price, warranty_months, note, note_public, sort, match_key)
      VALUES (@category, @name, @condition, @price, @warranty_months, @note, @note_public, @sort, @match_key)`);
  const upd = db.prepare(`UPDATE pc_parts SET category=@category, name=@name, condition=@condition, price=@price, warranty_months=@warranty_months,
      note=@note, note_public=@note_public, sort=@sort, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`);
  const setSort = db.prepare('UPDATE pc_parts SET sort = ? WHERE match_key = ?');
  const del = db.prepare('DELETE FROM pc_parts WHERE id = ?');
  const batch = 'BG' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex');
  const c = db.transaction(() => {
    d.added.forEach(r => ins.run(r));
    d.changed.forEach(r => upd.run(r));
    data.rows.forEach(r => setSort.run(r.sort, r.match_key)); // giữ đúng thứ tự trong file
    let removed = 0;
    d.missing.forEach(p => { if (remove.has(p.id)) { del.run(p.id); removed++; } });
    db.prepare(`INSERT INTO import_batches (id, kind, file_name, row_count, total, user_name) VALUES (?, 'pc_parts', ?, ?, ?, ?)`)
      .run(batch, data.fileName, data.rows.length, d.added.length, req.user.full_name);
    return { added: d.added.length, changed: d.changed.length, removed };
  })();
  const linked = pc.autoLink();
  fs.rmSync(tmpFile(req.session.pcImportToken), { force: true });
  delete req.session.pcImportToken;
  notify('inventory', `${req.user.full_name} cập nhật báo giá linh kiện "${data.fileName}": +${c.added} mới, ${c.changed} thay đổi`, '/manager/pc-parts', req.user.full_name);
  req.flash('success', `Đã cập nhật báo giá: ${c.added} món mới, ${c.changed} món thay đổi${c.removed ? `, xóa ${c.removed} món` : ''}${linked ? `, tự ghép ${linked} món kho` : ''}.`);
  res.redirect('/manager/pc-parts');
});

router.post('/import/pc-parts/cancel', (req, res) => {
  if (req.session.pcImportToken) fs.rmSync(tmpFile(req.session.pcImportToken), { force: true });
  delete req.session.pcImportToken;
  res.redirect('/manager/import/pc-parts');
});

module.exports = router;
