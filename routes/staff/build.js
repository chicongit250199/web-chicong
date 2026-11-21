'use strict';
// Build PC: chọn linh kiện từ báo giá (liên kết kho), lưu cấu hình, in phiếu, chốt bán; nhập kho cho món "Hàng đặt"
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const inv = require('../../services/inventory');
const pc = require('../../services/pcParts');
const settings = require('../../services/settings');
const { notify } = require('../../services/events');

const router = express.Router();
const nav = (req, res, next) => { res.locals.nav = 'build'; next(); };
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Dữ liệu cho trình build: linh kiện đang bán + tồn kho + thông số
function partsData() {
  const { byPart } = pc.stockInfo();
  return db.prepare('SELECT id, category, name, condition, price, warranty_months, note_public, specs, summary FROM pc_parts WHERE hidden = 0 ORDER BY sort, id').all()
    .map(p => ({ ...p, specs: parseJson(p.specs, {}), type: pc.typeOf(p.category), stock: byPart.get(p.id)?.qty || 0 }));
}
function categoriesOrdered(parts) {
  const seen = new Map();
  parts.forEach((p, i) => { if (!seen.has(p.category)) seen.set(p.category, { category: p.category, type: p.type, first: i }); });
  return [...seen.values()].sort((a, b) => pc.TYPE_ORDER.indexOf(a.type) - pc.TYPE_ORDER.indexOf(b.type) || a.first - b.first).map(c => ({ category: c.category, type: c.type }));
}

// ---------- Danh sách cấu hình ----------
router.get('/build', nav, (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = q ? `WHERE is_template = 0 AND (code LIKE @s OR vn(name) LIKE @v OR vn(customer_name) LIKE @v OR customer_phone LIKE @s)` : 'WHERE is_template = 0';
  const builds = db.prepare(`SELECT * FROM pc_builds ${where} ORDER BY updated_at DESC LIMIT 100`).all({ s: `%${q}%`, v: `%${db.vn(q)}%` });
  const templates = db.prepare('SELECT * FROM pc_builds WHERE is_template = 1 ORDER BY total').all();
  const partCount = db.prepare('SELECT COUNT(*) n FROM pc_parts WHERE hidden = 0').get().n;
  res.render('staff/build_list', { title: 'Build PC', builds, templates, q, partCount, parseJson });
});

// ---------- Trình build ----------
function renderBuilder(res, build) {
  const parts = partsData();
  const templates = db.prepare('SELECT id, code, name, total, items FROM pc_builds WHERE is_template = 1 ORDER BY total').all()
    .map(t => ({ id: t.id, name: t.name || t.code, total: t.total, items: parseJson(t.items, []) }));
  res.render('staff/build', {
    title: build.id ? `Cấu hình ${build.code}` : 'Build PC mới', build,
    payload: { parts, cats: categoriesOrdered(parts), templates, build },
    scripts: ['/js/pc-parts.js', '/js/build.js'],
  });
}

router.get('/build/new', nav, (req, res) => {
  const from = req.query.from ? db.prepare('SELECT * FROM pc_builds WHERE id = ?').get(req.query.from) : null;
  renderBuilder(res, {
    id: null, code: null, name: from && from.is_template ? from.name : '', customer_name: '', customer_phone: '', customer_addr: '', note: '',
    items: from ? parseJson(from.items, []) : [], discount: from ? from.discount : 0, deposit: 0, is_template: 0, refreshPrices: Boolean(from),
  });
});

router.get('/build/:id', nav, (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const b = db.prepare('SELECT * FROM pc_builds WHERE id = ?').get(req.params.id);
  if (!b) return next();
  renderBuilder(res, { ...b, items: parseJson(b.items, []) });
});

const lineSchema = v.z.object({
  part_id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
  category: v.text(60),
  name: v.reqText('Dòng thiếu tên', 300),
  condition: v.text(40),
  price: v.money.transform(x => x ?? 0),
  qty: v.z.coerce.number().int().min(1, 'Số lượng tối thiểu 1').max(99),
  warranty_months: v.intOpt,
  note: v.text(300),
});
const buildSchema = v.z.object({
  id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
  name: v.text(120),
  customer_name: v.text(120),
  customer_phone: v.phone(false),
  customer_addr: v.text(300),
  note: v.text(1000),
  items: v.z.array(lineSchema).min(1, 'Cấu hình chưa có linh kiện nào').max(60),
  discount: v.money.transform(x => x ?? 0),
  deposit: v.money.transform(x => x ?? 0),
  is_template: v.z.preprocess(x => (x === true || x === 1 || x === '1' ? 1 : 0), v.z.number()),
});

function nextCode() {
  const d = new Date(Date.now() + 7 * 3600e3).toISOString();
  const prefix = `PC-${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-`;
  const last = db.prepare('SELECT code FROM pc_builds WHERE code LIKE ? ORDER BY code DESC LIMIT 1').get(prefix + '%');
  return prefix + String((last ? Number(last.code.slice(prefix.length)) : 0) + 1).padStart(2, '0');
}

router.post('/api/build', (req, res) => {
  const { data, error } = v.parse(buildSchema, req.body);
  if (error) return res.status(422).json({ error });
  const subtotal = data.items.reduce((s, l) => s + l.price * l.qty, 0);
  if (data.discount > subtotal) return res.status(422).json({ error: 'Giảm giá lớn hơn tổng tiền' });
  const row = { ...data, items: JSON.stringify(data.items), total: subtotal - data.discount, staff_name: req.user.full_name };
  if (data.is_template && !row.name) return res.status(422).json({ error: 'Đặt tên cho cấu hình mẫu (VD: Gaming 15 triệu)' });
  let id = data.id;
  if (id) {
    const cur = db.prepare('SELECT id, sold_at FROM pc_builds WHERE id = ?').get(id);
    if (!cur) return res.status(404).json({ error: 'Cấu hình không còn' });
    db.prepare(`UPDATE pc_builds SET name=@name, customer_name=@customer_name, customer_phone=@customer_phone, customer_addr=@customer_addr, note=@note,
        items=@items, discount=@discount, deposit=@deposit, total=@total, is_template=@is_template, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`).run(row);
  } else {
    row.code = nextCode();
    id = db.prepare(`INSERT INTO pc_builds (code, name, customer_name, customer_phone, customer_addr, note, items, discount, deposit, total, is_template, staff_name)
        VALUES (@code, @name, @customer_name, @customer_phone, @customer_addr, @note, @items, @discount, @deposit, @total, @is_template, @staff_name)`).run(row).lastInsertRowid;
  }
  const b = db.prepare('SELECT id, code FROM pc_builds WHERE id = ?').get(id);
  res.json({ ok: true, id: b.id, code: b.code, message: `Đã lưu ${data.is_template ? 'cấu hình mẫu' : 'cấu hình'} ${b.code}` });
});

router.post('/build/:id/delete', (req, res) => {
  const b = db.prepare('SELECT * FROM pc_builds WHERE id = ?').get(req.params.id);
  if (b) db.prepare('DELETE FROM pc_builds WHERE id = ?').run(b.id);
  req.flash('success', b ? `Đã xóa cấu hình ${b.code}${b.name ? ' — ' + b.name : ''}.` : 'Cấu hình không còn.');
  res.redirect('/staff/build');
});

// ---------- In phiếu (báo giá / thanh toán - bảo hành), tiếng Việt / Anh ----------
const COND_EN = { new: 'New', '2nd': 'Used', 'like new': 'Like New', 'tray new': 'Tray New' };
router.get('/build/:id/print', (req, res, next) => {
  const b = db.prepare('SELECT * FROM pc_builds WHERE id = ?').get(req.params.id);
  if (!b) return next();
  const en = req.query.lang === 'en';
  const doc = req.query.doc === 'receipt' ? 'receipt' : 'quote';
  const items = parseJson(b.items, []).map(l => ({
    ...l,
    label: `${l.name}${l.condition ? ` (${en ? COND_EN[String(l.condition).toLowerCase()] || l.condition : l.condition})` : ''}`,
    amount: l.price * l.qty,
  }));
  const subtotal = items.reduce((s, l) => s + l.amount, 0);
  const now = new Date(Date.now() + 7 * 3600e3);
  const dateText = en
    ? `Da Nang, ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
    : `Đà Nẵng, Ngày ${now.getUTCDate()} Tháng ${now.getUTCMonth() + 1} Năm ${now.getUTCFullYear()}`;
  const DEF = require('../manager/pcParts');
  res.render('staff/build_print', {
    b, items, subtotal, en, doc, dateText,
    words: en ? pc.enWords(b.total) : pc.vnWords(b.total),
    remainingWords: en ? pc.enWords(Math.max(0, b.total - b.deposit)) : pc.vnWords(Math.max(0, b.total - b.deposit)),
    printNote: en ? settings.get('pc_print_note_en') || DEF.DEFAULT_NOTE_EN : settings.get('pc_print_note_vi') || DEF.DEFAULT_NOTE_VI,
    staffName: b.staff_name || req.user.full_name,
  });
});

// ---------- Nhập kho cho món "Hàng đặt" (hàng đã về) ----------
const receiveSchema = v.z.object({
  serials: v.text(20000),
  quantity: v.z.preprocess(x => (x === '' || x == null ? 1 : Number(x)), v.z.number().int().min(1, 'Số lượng tối thiểu 1').max(500, 'Tối đa 500 / lần')),
  supplier: v.text(200),
  tech_price: v.money,
  import_date: v.date,
});
router.post('/pc-parts/:id/receive', (req, res) => {
  const part = db.prepare('SELECT * FROM pc_parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Linh kiện không còn trong báo giá' });
  const { data, error } = v.parse(receiveSchema, req.body);
  if (error) return res.status(422).json({ error });
  const serials = [...new Set(String(data.serials || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean))];
  const dup = inv.existingSerials(serials);
  if (dup.length) return res.status(409).json({ error: `Serial đã có trong kho: ${dup.map(d => d.serial).join(', ')}` });
  const count = serials.length || data.quantity;
  // Tên trong kho = tên báo giá (giữ nguyên để tự ghép); mã hàng: dùng lại mã của món kho đã ghép nếu có
  const existing = pc.stockUnits(part.id)[0];
  const itemCode = existing?.item_code || inv.makeItemCode(part.name);
  const ins = db.prepare(`INSERT INTO inventory_items (item_code, name, serial, import_date, condition, supplier, tech_price, retail_price, warranty_out_months, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_stock')`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      ins.run(itemCode, part.name, serials[i] || null, data.import_date || fmt.todayYmd(), part.condition, data.supplier, data.tech_price, part.price, part.warranty_months);
    }
    pc.link(part.name, part.id);
  })();
  const stock = pc.stockInfo().byPart.get(part.id)?.qty || 0;
  notify('inventory', `${req.user.full_name} nhập kho ${count} × ${pc.displayName(part)} (hàng đặt đã về)`, '/staff/inventory?q=' + encodeURIComponent(part.name), req.user.full_name);
  res.json({ ok: true, stock, message: `Đã nhập ${count} cái vào kho` });
});

module.exports = router;
module.exports.partsData = partsData;
