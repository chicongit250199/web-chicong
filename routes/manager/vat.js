'use strict';
// Kho hóa đơn VAT — tách biệt hoàn toàn với kho hàng thường
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const drive = require('../../services/driveService');
const ai = require('../../services/aiService');
const vatSync = require('../../services/vatSync');

const router = express.Router();
const TABS = ['in', 'stock', 'exported', 'exports', 'out'];


router.get('/vat', (req, res) => {
  res.locals.nav = 'm-vat';
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'stock';
  const s = String(req.query.q || '').trim();
  const like = `%${s}%`;
  let rows = [];
  if (tab === 'in' || tab === 'out') {
    rows = db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM vat_items x WHERE x.invoice_id = i.id) AS item_count,
        (SELECT group_concat(item_name, ' · ') FROM (SELECT item_name FROM vat_items x WHERE x.invoice_id = i.id LIMIT 4)) AS item_preview
        FROM vat_invoices i WHERE i.direction = ? ${s ? 'AND (i.partner_name LIKE @l OR i.partner_tax_id LIKE @l OR i.invoice_number LIKE @l OR i.file_name LIKE @l)' : ''}
        ORDER BY i.invoice_date DESC, i.id DESC LIMIT 500`.replace(/@l/g, '?')).all(tab, ...(s ? [like, like, like, like] : []));
  } else if (tab === 'stock' || tab === 'exported') {
    rows = db.prepare(`SELECT x.*, i.invoice_number, i.invoice_symbol, i.invoice_date, i.partner_name, i.drive_link, i.pdf_link
        FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id
        WHERE i.direction = 'in' AND x.status = ? ${s ? 'AND (x.item_name LIKE ? OR i.partner_name LIKE ? OR i.invoice_number LIKE ?)' : ''}
        ORDER BY i.invoice_date DESC, x.id LIMIT 1000`).all(tab === 'stock' ? 'available' : 'depleted', ...(s ? [like, like, like] : []));
  } else {
    rows = db.prepare(`SELECT e.*, x.item_name, x.unit, x.unit_price, i.invoice_number, i.partner_name FROM vat_item_exports e
        JOIN vat_items x ON x.id = e.vat_item_id JOIN vat_invoices i ON i.id = x.invoice_id
        ${s ? 'WHERE x.item_name LIKE ? OR e.buyer_name LIKE ? OR e.buyer_tax_id LIKE ?' : ''} ORDER BY e.id DESC LIMIT 500`).all(...(s ? [like, like, like] : []));
  }
  const counts = {
    in: db.prepare(`SELECT COUNT(*) c FROM vat_invoices WHERE direction = 'in'`).get().c,
    out: db.prepare(`SELECT COUNT(*) c FROM vat_invoices WHERE direction = 'out'`).get().c,
    stock: db.prepare(`SELECT COUNT(*) c FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE i.direction = 'in' AND x.status = 'available'`).get().c,
    exported: db.prepare(`SELECT COUNT(*) c FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE i.direction = 'in' AND x.status = 'depleted'`).get().c,
    exports: db.prepare('SELECT COUNT(*) c FROM vat_item_exports').get().c,
  };
  const errors = db.prepare(`SELECT * FROM vat_drive_files WHERE status = 'error' ORDER BY processed_at DESC LIMIT 20`).all();
  res.render('manager/vat', { title: 'Kho hóa đơn VAT', tab, rows, counts, search: s, errors, driveStatus: drive.status(), aiEnabled: ai.isEnabled() });
});

router.get('/vat/invoices/:id', (req, res, next) => {
  const inv = db.prepare('SELECT * FROM vat_invoices WHERE id = ?').get(req.params.id);
  if (!inv) return next();
  const items = db.prepare('SELECT * FROM vat_items WHERE invoice_id = ? ORDER BY id').all(inv.id);
  res.json({ invoice: inv, items });
});

router.post('/vat/sync/:direction', (req, res) => {
  const direction = req.params.direction === 'out' ? 'out' : 'in';
  const folder = direction === 'in' ? config.driveVatInputFolderId : config.driveVatOutputFolderId;
  if (!folder) return res.status(400).json({ error: `Chưa cấu hình ${direction === 'in' ? 'DRIVE_VAT_INPUT_FOLDER_ID' : 'DRIVE_VAT_OUTPUT_FOLDER_ID'} trong .env` });
  if (!drive.status().credentials) return res.status(400).json({ error: 'Chưa có file Service Account (credentials/service-account.json)' });
  const { job, started } = vatSync.start(direction, req.user.full_name);
  res.status(started ? 202 : 409).json({ started, job, error: started ? null : 'Đang quét, vui lòng chờ xong rồi bấm lại.' });
});

router.get('/vat/sync/status', (req, res) => res.json({ job: vatSync.status() }));

const exportSchema = v.z.object({
  quantity: v.z.coerce.number().positive('Số lượng phải > 0'),
  buyer_name: v.text(200), buyer_tax_id: v.text(20), note: v.text(500),
});

router.post('/vat/items/:id/export', (req, res) => {
  const back = `/manager/vat?tab=stock${req.body.q ? '&q=' + encodeURIComponent(req.body.q) : ''}`;
  const { data, error } = v.parse(exportSchema, req.body);
  if (error) { req.flash('error', error); return res.redirect(back); }
  const r = db.transaction(() => {
    const item = db.prepare(`SELECT x.* FROM vat_items x JOIN vat_invoices i ON i.id = x.invoice_id WHERE x.id = ? AND i.direction = 'in'`).get(req.params.id);
    if (!item) return { error: 'Không tìm thấy mặt hàng VAT.' };
    if (data.quantity > item.quantity_remaining + 1e-9) return { error: `Chỉ còn ${fmt.num(item.quantity_remaining)} ${item.unit || ''}.` };
    const remaining = Math.round((item.quantity_remaining - data.quantity) * 1000) / 1000;
    db.prepare('UPDATE vat_items SET quantity_remaining = ?, status = ? WHERE id = ?').run(remaining, remaining <= 0 ? 'depleted' : 'available', item.id);
    db.prepare('INSERT INTO vat_item_exports (vat_item_id, quantity, buyer_name, buyer_tax_id, note, user_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, data.quantity, data.buyer_name, data.buyer_tax_id, data.note, req.user.full_name);
    return { item, remaining };
  })();
  if (r.error) req.flash('error', r.error);
  else req.flash('success', `Đã xuất ${fmt.num(data.quantity)} ${r.item.unit || ''} "${r.item.item_name}" — còn ${fmt.num(r.remaining)}${r.remaining <= 0 ? ' (hết)' : ''}.`);
  res.redirect(back);
});

// Hoàn tác 1 lần xuất
router.post('/vat/exports/:id/undo', (req, res) => {
  db.transaction(() => {
    const e = db.prepare('SELECT * FROM vat_item_exports WHERE id = ?').get(req.params.id);
    if (!e) return;
    db.prepare(`UPDATE vat_items SET quantity_remaining = MIN(quantity_in, quantity_remaining + ?), status = 'available' WHERE id = ?`).run(e.quantity, e.vat_item_id);
    db.prepare('DELETE FROM vat_item_exports WHERE id = ?').run(e.id);
  })();
  req.flash('success', 'Đã hoàn tác lần xuất.');
  res.redirect('/manager/vat?tab=exports');
});

module.exports = router;
