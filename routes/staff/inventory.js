'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const inv = require('../../services/inventory');
const { notify } = require('../../services/events');

const router = express.Router();
const PAGE = 50;

// ---------- Xem kho: 2 tab tồn kho / đã bán ----------
router.get('/inventory', (req, res) => {
  res.locals.nav = 'inventory';
  const tab = req.query.tab === 'sold' ? 'sold' : 'in_stock';
  const s = String(req.query.q || '').trim();
  const where = ['status = @tab'];
  if (s) where.push('(name LIKE @s OR item_code LIKE @s OR serial LIKE @s OR supplier LIKE @s OR customer_phone LIKE @s OR customer_name LIKE @s)');
  const params = { tab, s: `%${s}%` };
  const total = db.prepare(`SELECT COUNT(*) c FROM inventory_items WHERE ${where.join(' AND ')}`).get(params).c;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const order = tab === 'sold' ? 'sold_date DESC, id DESC' : 'import_date DESC, id DESC';
  const items = db.prepare(`SELECT * FROM inventory_items WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`).all(params)
    .map(i => ({ ...i, warranty_end: inv.warrantyEnd(i.sold_date, i.warranty_out_months) }));
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) c FROM inventory_items GROUP BY status').all().map(r => [r.status, r.c]));
  const stockValue = db.prepare(`SELECT COALESCE(SUM(tech_price),0) tech, COALESCE(SUM(retail_price),0) retail FROM inventory_items WHERE status = 'in_stock'`).get();
  res.render('staff/inventory', { title: 'Xem kho', tab, search: s, items, total, page, pages, counts, stockValue, today: fmt.todayYmd() });
});

// ---------- Nhập kho ----------
const importSchema = v.z.object({
  item_code: v.text(64),
  name: v.reqText('Nhập tên hàng hóa / linh kiện', 300),
  serials: v.text(20000),
  quantity: v.z.preprocess(x => (x === '' || x == null ? 1 : Number(x)), v.z.number().int().min(1, 'Số lượng tối thiểu 1').max(500, 'Tối đa 500 / lần')),
  import_date: v.date,
  condition: v.text(100),
  supplier: v.text(200),
  warranty_in_months: v.intOpt,
  tech_price: v.money,
  retail_price: v.money,
  warranty_out_months: v.intOpt,
  note: v.text(1000),
});

router.get('/inventory/new', (req, res) => {
  res.locals.nav = 'inventory-new';
  const suppliers = db.prepare(`SELECT DISTINCT supplier FROM inventory_items WHERE supplier IS NOT NULL AND supplier <> '' ORDER BY supplier LIMIT 100`).all().map(r => r.supplier);
  res.render('staff/inventory_new', { title: 'Nhập kho', values: { import_date: fmt.todayYmd() }, error: null, suppliers });
});

router.post('/inventory', (req, res) => {
  const render = (status, error) => {
    res.locals.nav = 'inventory-new';
    res.status(status).render('staff/inventory_new', { title: 'Nhập kho', values: req.body, error, suppliers: [] });
  };
  const { data, error } = v.parse(importSchema, req.body);
  if (error) return render(422, error);
  const serials = [...new Set(String(data.serials || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean))];
  const dup = inv.existingSerials(serials);
  if (dup.length) return render(409, `Serial đã có trong kho: ${dup.map(d => d.serial).join(', ')}`);
  const count = serials.length || data.quantity;
  const itemCode = data.item_code || inv.makeItemCode(data.name);
  const ins = db.prepare(`INSERT INTO inventory_items (item_code, name, serial, import_date, condition, supplier, warranty_in_months, tech_price, retail_price, status, warranty_out_months, note)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?)`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      ins.run(itemCode, data.name, serials[i] || null, data.import_date || fmt.todayYmd(), data.condition, data.supplier,
        data.warranty_in_months, data.tech_price, data.retail_price, data.warranty_out_months, data.note);
    }
  })();
  notify('inventory', `${req.user.full_name} nhập kho ${count} × ${data.name}`, `/staff/inventory?q=${encodeURIComponent(itemCode)}`, req.user.full_name);
  req.flash('success', `Đã nhập ${count} × ${data.name} (mã ${itemCode}).`);
  res.redirect('/staff/inventory/new');
});

// ---------- Xóa hàng trong kho ----------
// Nhân viên: chỉ hàng đang tồn kho. Quản lý: cả hàng đã bán (doanh thu giữ nguyên, chỉ xóa bản ghi kho).
router.post('/inventory/delete', (req, res) => {
  const backTo = typeof req.body.back === 'string' && /^\/staff\/inventory(\?|$)/.test(req.body.back) ? req.body.back : '/staff/inventory';
  const ids = [...new Set([].concat(req.body.ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 1000);
  if (!ids.length) { req.flash('error', 'Chưa chọn món nào.'); return res.redirect(backTo); }
  const isManager = req.user.role === 'manager';
  const ph = ids.map(() => '?').join(',');
  const items = db.prepare(`SELECT id, name, serial, status FROM inventory_items WHERE id IN (${ph})`).all(...ids);
  const allowed = items.filter(i => isManager || i.status === 'in_stock');
  const denied = items.length - allowed.length;
  if (!allowed.length) {
    req.flash('error', denied ? 'Hàng đã bán chỉ Quản lý được xóa.' : 'Không tìm thấy món hàng.');
    return res.redirect(backTo);
  }
  const del = db.prepare('DELETE FROM inventory_items WHERE id = ?');
  db.transaction(() => { for (const i of allowed) del.run(i.id); })();
  const sold = allowed.filter(i => i.status === 'sold').length;
  const label = allowed.length === 1 ? `${allowed[0].name}${allowed[0].serial ? ' (SN ' + allowed[0].serial + ')' : ''}` : `${allowed.length} món`;
  notify('revenue_deleted', `${req.user.full_name} xóa khỏi kho: ${label}${sold ? ` (${sold} món đã bán)` : ''}`, '/staff/inventory', req.user.full_name);
  req.flash('success', `Đã xóa ${label} khỏi kho${denied ? `; bỏ qua ${denied} món đã bán (chỉ Quản lý được xóa)` : ''}.`);
  res.redirect(backTo);
});

module.exports = router;
