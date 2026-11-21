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
  // Gom các dòng cùng đơn (order_code) thành 1 giao dịch
  const rows = db.prepare(`SELECT * FROM revenues WHERE source IS NULL AND (type = 'sale' OR ref_id IS NULL) ORDER BY id DESC LIMIT 60`).all();
  const recent = [];
  for (const r of rows) {
    const last = recent[recent.length - 1];
    if (r.order_code && last && last.order_code === r.order_code) { last.lines.push(r.content); last.amount += r.amount; continue; }
    if (recent.length >= 10) break;
    recent.push({ ...r, lines: [r.content] });
  }
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

const lineSchema = v.z.object({
  // Chọn từ kho: item_id. Hàng ngoài kho / dịch vụ: để trống item_id, nhập name + kind
  item_id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
  name: v.text(300),
  kind: v.z.preprocess(x => (x === 'sale' ? 'sale' : 'repair'), v.z.enum(['repair', 'sale'])),
  price: v.money.refine(x => x != null, 'Nhập giá tiền cho từng món'),
  warranty_months: v.intOpt,
}).refine(d => d.item_id || d.name, { message: 'Nhập tên hàng hóa / dịch vụ' });

const sellSchema = v.z.object({
  items: v.z.array(lineSchema).min(1, 'Chưa có món nào trong đơn').max(50, 'Tối đa 50 món mỗi đơn'),
  payment_method: v.oneOf(['cash', 'transfer'], 'Chọn hình thức thanh toán'),
  customer_name: v.text(120),
  customer_phone: v.phone(false),
  delivery_address: v.text(500),
  sale_date: v.date, // để trống = hôm nay; cho phép ghi lùi ngày bán
}).refine(d => new Set(d.items.filter(i => i.item_id).map(i => i.item_id)).size === d.items.filter(i => i.item_id).length,
  { message: 'Một món (serial) bị chọn 2 lần trong đơn' });

// Mã đơn: BH-YYMMDD-HHMMSS-xxx (giờ VN)
function newOrderCode() {
  const d = new Date(Date.now() + 7 * 3600e3).toISOString();
  return `BH-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}-${Math.random().toString(36).slice(2, 5)}`;
}

router.post('/sell', (req, res) => {
  // tương thích form cũ: 1 món gửi phẳng
  const body = Array.isArray(req.body?.items) ? req.body : { ...req.body, items: [req.body || {}] };
  const { data, error } = v.parse(sellSchema, body);
  if (error) return res.status(422).json({ error });
  const today = fmt.todayYmd();
  if (data.sale_date && data.sale_date.slice(0, 10) > today) return res.status(422).json({ error: 'Ngày bán không được sau hôm nay' });
  const saleDay = data.sale_date ? data.sale_date.slice(0, 10) : today;
  // Ngày khác hôm nay: giữ giờ hiện tại (giờ VN) trên ngày đã chọn
  const now = saleDay === today ? new Date().toISOString()
    : new Date(`${saleDay}T${new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 23)}+07:00`).toISOString();
  const orderCode = data.items.length > 1 ? newOrderCode() : null;
  const insRevenue = db.prepare(`INSERT INTO revenues (type, ref_id, customer_name, customer_phone, delivery_address, content, amount, payment_method, warranty_months, staff_name, created_at, order_code)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getItem = db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND status = 'in_stock'`);
  const markSold = db.prepare(`UPDATE inventory_items SET status = 'sold', sold_date = ?, customer_name = ?, customer_phone = ?, warranty_out_months = ? WHERE id = ?`);

  let lines;
  try {
    lines = db.transaction(() => data.items.map(line => {
      if (!line.item_id) {
        // Hàng ngoài kho / dịch vụ: chỉ ghi doanh thu, không trừ kho
        insRevenue.run(line.kind, null, data.customer_name, data.customer_phone, data.delivery_address, line.name, line.price, data.payment_method,
          line.warranty_months ?? 0, req.user.full_name, now, orderCode);
        return { content: line.name, price: line.price, kind: line.kind };
      }
      // Bán từ kho: trừ đúng món (serial)
      const item = getItem.get(line.item_id);
      if (!item) { const e = new Error('gone'); e.gone = true; throw e; }
      const warranty = line.warranty_months ?? item.warranty_out_months ?? 0;
      markSold.run(saleDay, data.customer_name, data.customer_phone, warranty, item.id);
      const content = `${item.name}${item.serial ? ' — SN: ' + item.serial : ''}`;
      insRevenue.run('sale', item.id, data.customer_name, data.customer_phone, data.delivery_address, content, line.price, data.payment_method, warranty, req.user.full_name, now, orderCode);
      return { content, price: line.price, kind: 'sale', serial: item.serial };
    }))();
  } catch (e) {
    if (e.gone) return res.status(409).json({ error: 'Có món trong đơn vừa được bán hoặc không còn trong kho. Hãy chọn lại.' });
    throw e;
  }

  const total = lines.reduce((s, l) => s + l.price, 0);
  const what = lines.length === 1 ? lines[0].content : `${lines.length} món (${lines.map(l => l.content).join('; ')})`;
  const verb = lines.every(l => l.kind === 'repair') ? 'thu dịch vụ' : 'bán';
  const serial = lines.find(l => l.serial)?.serial;
  notify('sale', `${req.user.full_name} ${verb} ${what} — ${fmt.money(total)} (${fmt.payment(data.payment_method)})`,
    `/staff/search?q=${encodeURIComponent(data.customer_phone || serial || '')}`, req.user.full_name);
  res.json({ ok: true, message: `${saleDay !== today ? '[Ngày ' + saleDay.split('-').reverse().join('/') + '] ' : ''}Đã ghi ${lines.length > 1 ? 'đơn ' + lines.length + ' món' : '"' + lines[0].content + '"'} — tổng ${fmt.money(total)}` });
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
