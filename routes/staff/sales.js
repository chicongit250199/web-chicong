'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const inv = require('../../services/inventory');
const { notify } = require('../../services/events');

const router = express.Router();

// ---------- Bán hàng ----------
const qUnits = db.prepare(`SELECT id, serial, retail_price, condition, import_date, warranty_out_months FROM inventory_items
    WHERE status = 'in_stock' AND COALESCE(item_code,'') = COALESCE(?, '') AND name = ? ORDER BY (serial LIKE ?) DESC, import_date, id LIMIT 100`);

// Nhóm hàng (cùng mã + tên) chứa 1 món cụ thể — dùng khi bấm "Bán" từ trang kho
function groupOf(itemId) {
  const it = db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND status = 'in_stock'`).get(itemId);
  if (!it) return null;
  const g = db.prepare(`SELECT item_code, name, COUNT(*) AS qty, MAX(retail_price) AS retail_price, MAX(warranty_out_months) AS warranty_out_months
      FROM inventory_items WHERE status = 'in_stock' AND COALESCE(item_code,'') = COALESCE(?, '') AND name = ?`).get(it.item_code, it.name);
  const units = qUnits.all(it.item_code, it.name, '');
  // đưa món được chọn lên đầu danh sách
  units.sort((a, b) => (a.id === it.id ? -1 : b.id === it.id ? 1 : 0));
  return { ...g, units, selected: it.id };
}

router.get('/sell', (req, res) => {
  res.locals.nav = 'sell';
  const recent = db.prepare(`SELECT * FROM revenues WHERE type = 'sale' ORDER BY id DESC LIMIT 10`).all();
  let preset = null;
  if (req.query.item) {
    preset = groupOf(Number(req.query.item));
    if (!preset) res.locals.flash = [...(res.locals.flash || []), { type: 'error', message: 'Món hàng này không còn trong kho (đã bán hoặc đã xóa).' }];
  }
  res.render('staff/sell', { title: 'Bán hàng / Dịch vụ', recent, preset, scripts: ['/js/sell.js'] });
});

// Gợi ý hàng còn tồn: gom theo mã hàng + tên, kèm số lượng và danh sách serial
router.get('/api/inventory/suggest', (req, res) => {
  const s = String(req.query.q || '').trim();
  if (s.length < 1) return res.json({ items: [] });
  const like = `%${s}%`;
  const likeVn = `%${db.vn(s)}%`; // tìm không phân biệt dấu: "chuot" khớp "Chuột"
  const groups = db.prepare(`SELECT item_code, name, COUNT(*) AS qty, MAX(retail_price) AS retail_price, MAX(warranty_out_months) AS warranty_out_months
      FROM inventory_items WHERE status = 'in_stock' AND (vn(name) LIKE ? OR vn(item_code) LIKE ? OR serial LIKE ?)
      GROUP BY item_code, name ORDER BY qty DESC, name LIMIT 15`).all(likeVn, likeVn, like);
  res.json({ items: groups.map(g => ({ ...g, units: qUnits.all(g.item_code, g.name, like) })) });
});

const sellSchema = v.z.object({
  // Chọn từ kho: item_id. Hàng ngoài kho / dịch vụ: để trống item_id, nhập name + kind
  item_id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
  name: v.text(300),
  kind: v.z.preprocess(x => (x === 'sale' ? 'sale' : 'repair'), v.z.enum(['repair', 'sale'])),
  price: v.money.refine(x => x != null, 'Nhập giá tiền'),
  payment_method: v.oneOf(['cash', 'transfer'], 'Chọn hình thức thanh toán'),
  customer_name: v.text(120),
  customer_phone: v.phone(false),
  delivery_address: v.text(500),
  warranty_months: v.intOpt,
}).refine(d => d.item_id || d.name, { message: 'Nhập tên hàng hóa / dịch vụ' });

router.post('/sell', (req, res) => {
  const { data, error } = v.parse(sellSchema, req.body);
  if (error) return res.status(422).json({ error });
  const now = new Date().toISOString();
  const insRevenue = db.prepare(`INSERT INTO revenues (type, ref_id, customer_name, customer_phone, delivery_address, content, amount, payment_method, warranty_months, staff_name, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // ---- Hàng ngoài kho / dịch vụ: chỉ ghi doanh thu, không trừ kho ----
  if (!data.item_id) {
    const warranty = data.warranty_months ?? 0;
    insRevenue.run(data.kind, null, data.customer_name, data.customer_phone, data.delivery_address, data.name, data.price, data.payment_method, warranty, req.user.full_name, now);
    const label = data.kind === 'repair' ? 'dịch vụ' : 'hàng ngoài kho';
    notify('sale', `${req.user.full_name} thu ${label}: ${data.name} — ${fmt.money(data.price)} (${fmt.payment(data.payment_method)})`,
      data.customer_phone ? `/staff/search?q=${encodeURIComponent(data.customer_phone)}` : '/manager', req.user.full_name);
    return res.json({ ok: true, message: `Đã ghi ${label} "${data.name}" — ${fmt.money(data.price)}` });
  }

  // ---- Bán từ kho: trừ đúng món (serial) ----
  const result = db.transaction(() => {
    const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND status = 'in_stock'`).get(data.item_id);
    if (!item) return null;
    const warranty = data.warranty_months ?? item.warranty_out_months ?? 0;
    db.prepare(`UPDATE inventory_items SET status = 'sold', sold_date = ?, customer_name = ?, customer_phone = ?, warranty_out_months = ? WHERE id = ?`)
      .run(fmt.todayYmd(), data.customer_name, data.customer_phone, warranty, item.id);
    const content = `${item.name}${item.serial ? ' — SN: ' + item.serial : ''}`;
    const r = insRevenue.run('sale', item.id, data.customer_name, data.customer_phone, data.delivery_address, content, data.price, data.payment_method, warranty, req.user.full_name, now);
    return { item, revenueId: r.lastInsertRowid, content, warranty };
  })();
  if (!result) return res.status(409).json({ error: 'Món hàng này vừa được bán hoặc không còn trong kho. Hãy chọn lại.' });
  notify('sale', `${req.user.full_name} bán ${result.content} — ${fmt.money(data.price)} (${fmt.payment(data.payment_method)})`,
    `/staff/search?q=${encodeURIComponent(result.item.serial || data.customer_phone || '')}`, req.user.full_name);
  res.json({ ok: true, message: `Đã bán ${result.content} — ${fmt.money(data.price)}` });
});

// ---------- Tìm kiếm lịch sử Task + Serial bảo hành ----------
router.get('/search', (req, res) => {
  res.locals.nav = 'search';
  const s = String(req.query.q || '').trim();
  let tasks = []; let items = []; let sales = [];
  if (s) {
    const digits = s.replace(/[^\d]/g, '');
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    tasks = db.prepare(`SELECT * FROM tasks WHERE ticket_code = ? OR device_model LIKE ? ${phoneLike ? 'OR customer_phone LIKE ?' : ''}
                        ORDER BY created_at DESC LIMIT 100`).all(...[s, `%${s}%`, phoneLike].filter(Boolean));
    items = db.prepare(`SELECT * FROM inventory_items WHERE serial = ? OR serial LIKE ? ${phoneLike ? 'OR customer_phone LIKE ?' : ''}
                        ORDER BY sold_date DESC, id DESC LIMIT 100`).all(...[s, `%${s}%`, phoneLike].filter(Boolean))
      .map(i => ({ ...i, warranty_end: inv.warrantyEnd(i.sold_date, i.warranty_out_months) }));
    if (phoneLike) sales = db.prepare(`SELECT * FROM revenues WHERE customer_phone LIKE ? ORDER BY created_at DESC LIMIT 100`).all(phoneLike);
  }
  res.render('staff/search', { title: 'Tìm kiếm', search: s, tasks, items, sales, today: fmt.todayYmd() });
});

module.exports = router;
