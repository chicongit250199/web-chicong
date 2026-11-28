'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const inv = require('../../services/inventory');
const { notify } = require('../../services/events');
const pc = require('../../services/pcParts');

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

// Chốt bán từ Build PC: món có trong kho -> chọn sẵn serial (nhập sớm nhất); thiếu -> ghi "hàng ngoài kho"; giảm giá chia theo tỉ lệ tiền từng món
function buildPreset(buildId) {
  const b = db.prepare('SELECT * FROM pc_builds WHERE id = ? AND is_template = 0').get(buildId);
  if (!b) return null;
  const items = JSON.parse(b.items || '[]');
  const lines = [];
  for (const it of items) {
    const label = `${it.name}${it.condition ? ` (${it.condition})` : ''}`;
    const units = it.part_id ? pc.stockUnits(it.part_id).filter(u => !lines.some(l => l.item_id === u.id)) : [];
    const take = Math.min(units.length, it.qty);
    for (let i = 0; i < take; i++) {
      lines.push({ item_id: units[i].id, name: label, serial: units[i].serial, kind: 'sale', price: it.price, warranty: it.warranty_months ?? '', warrantyShow: it.warranty_months ?? 0,
        choices: units.map(u => ({ id: u.id, serial: u.serial })) });
    }
    const rest = it.qty - take;
    if (rest > 0) {
      lines.push({ item_id: null, name: rest > 1 ? `${label} x${rest}` : label, serial: null, kind: it.part_id ? 'sale' : 'repair', price: it.price * rest,
        warranty: it.warranty_months ?? '', warrantyShow: it.warranty_months ?? 0, external: Boolean(it.part_id) });
    }
  }
  // chia giảm giá theo tỉ lệ, làm tròn nghìn, phần lẻ trừ vào dòng đắt nhất
  const sum = lines.reduce((s, l) => s + l.price, 0);
  if (b.discount > 0 && sum > 0) {
    let left = b.discount;
    lines.forEach(l => { const d = Math.min(l.price, Math.floor(b.discount * l.price / sum / 1000) * 1000); l.price -= d; left -= d; });
    const top = lines.reduce((a, l) => (l.price > a.price ? l : a), lines[0]);
    top.price = Math.max(0, top.price - left);
  }
  lines.forEach(l => { l.price = String(l.price); });
  return { id: b.id, code: b.code, discount: b.discount, total: b.total, customer_name: b.customer_name || '', customer_phone: b.customer_phone || '', delivery_address: b.customer_addr || '', lines };
}

router.get('/sell', (req, res) => {
  res.locals.nav = 'sell';
  // Gom các dòng cùng đơn (order_code) thành 1 giao dịch; trả máy (có số phiếu) hiện cả dòng tiền sửa máy
  const rows = db.prepare(`SELECT * FROM revenues WHERE source IS NULL AND (type = 'sale' OR ref_id IS NULL OR order_code IS NOT NULL) ORDER BY id DESC LIMIT 60`).all();
  const recent = [];
  for (const r of rows) {
    const last = recent[recent.length - 1];
    if (r.order_code && last && last.order_code === r.order_code) { last.lines.unshift(r.content); last.amount += r.amount; last.created_at = r.created_at; continue; } // đọc ngược id -> chèn đầu để giữ đúng thứ tự trong đơn
    if (recent.length >= 10) break;
    recent.push({ ...r, lines: [r.content] });
  }
  let preset = null;
  if (req.query.item) {
    preset = groupOf(Number(req.query.item));
    if (!preset) res.locals.flash = [...(res.locals.flash || []), { type: 'error', message: 'Món hàng này không còn trong kho (đã bán hoặc đã xóa).' }];
  }
  const build = req.query.build ? buildPreset(Number(req.query.build)) : null;
  if (req.query.build && !build) res.locals.flash = [...(res.locals.flash || []), { type: 'error', message: 'Không tìm thấy cấu hình Build PC này.' }];
  res.render('staff/sell', { title: 'Bán hàng / Dịch vụ', recent, preset, build, scripts: ['/js/sell.js'] });
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

const { lineSchema, noDupSerial, newOrderCode, writeLines } = require('../../services/sales');
const debts = require('../../services/debts');

const sellSchema = v.z.object({
  items: v.z.array(lineSchema).min(1, 'Chưa có món nào trong đơn').max(50, 'Tối đa 50 món mỗi đơn'),
  payment_method: v.oneOf(['cash', 'transfer', 'debt'], 'Chọn hình thức thanh toán'),
  // Công nợ: khách trả trước 1 phần (0 = nợ toàn bộ), phần còn lại ghi nợ
  paid_amount: v.money,
  paid_method: v.z.preprocess(x => (x === 'transfer' ? 'transfer' : 'cash'), v.z.enum(['cash', 'transfer'])),
  customer_name: v.text(120),
  customer_phone: v.phone(false),
  delivery_address: v.text(500),
  sale_date: v.date, // để trống = hôm nay; cho phép ghi lùi ngày bán
  build_id: v.z.preprocess(x => (x === '' || x == null ? null : Number(x)), v.z.number().int().positive().nullable()),
}).refine(d => noDupSerial(d.items), { message: 'Một món (serial) bị chọn 2 lần trong đơn' });

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
  const orderCode = newOrderCode(); // mọi đơn đều có số phiếu (để in lại)
  const pay = debts.split(data.items.reduce((s, l) => s + l.price, 0), data.payment_method, data.paid_amount, data.paid_method);
  const debtKey = pay.method === 'debt' ? debts.keyFor({ name: data.customer_name, phone: data.customer_phone }) : null;
  if (pay.method === 'debt' && !debtKey) return res.status(422).json({ error: debts.NEED_CUSTOMER });
  let lines;
  try {
    lines = db.transaction(() => {
      const out = writeLines(data.items, {
        customer_name: data.customer_name, customer_phone: data.customer_phone, delivery_address: data.delivery_address,
        payment_method: pay.method, staff_name: req.user.full_name, now, saleDay, orderCode,
      });
      if (debtKey) debts.recordOrder({ key: debtKey, orderCode, upfront: pay.upfront, upfrontMethod: data.paid_method, staff: req.user.full_name, now });
      return out;
    })();
  } catch (e) {
    if (e.gone) return res.status(409).json({ error: e.message });
    throw e;
  }

  const total = lines.reduce((s, l) => s + l.price, 0);
  if (data.build_id) db.prepare(`UPDATE pc_builds SET sold_at = ?, order_code = ? WHERE id = ?`).run(now, orderCode, data.build_id);
  const what = lines.length === 1 ? lines[0].content : `${lines.length} món (${lines.map(l => l.content).join('; ')})`;
  const verb = lines.every(l => l.kind === 'repair') ? 'thu dịch vụ' : 'bán';
  const serial = lines.find(l => l.serial)?.serial;
  const payText = pay.method !== 'debt' ? fmt.payment(pay.method)
    : `Công nợ${pay.upfront ? ` — trả trước ${fmt.money(pay.upfront)} ${fmt.payment(data.paid_method).toLowerCase()}, nợ ${fmt.money(total - pay.upfront)}` : ''}`;
  notify('sale', `${req.user.full_name} ${verb} ${what} — ${fmt.money(total)} (${payText})`,
    `/staff/search?q=${encodeURIComponent(data.customer_phone || serial || '')}`, req.user.full_name);
  res.json({ ok: true, receipt: `/staff/sell/receipt/${orderCode}`, message: `${saleDay !== today ? '[Ngày ' + saleDay.split('-').reverse().join('/') + '] ' : ''}Đã ghi ${lines.length > 1 ? 'đơn ' + lines.length + ' món' : '"' + lines[0].content + '"'} — tổng ${fmt.money(total)}` });
});

// ---------- In phiếu thanh toán - bảo hành cho đơn bán (mẫu giống báo giá Build PC, khổ A4) ----------
// key = số phiếu (BH-...) hoặc id dòng doanh thu (đơn cũ chưa có số phiếu)
const COND_EN_SALE = { new: 'New', '2nd': 'Used', 'like new': 'Like New', 'tray new': 'Tray New' };
router.get('/sell/receipt/:key', async (req, res, next) => {
  const key = String(req.params.key);
  let rows = [];
  if (/^\d+$/.test(key)) {
    const r = db.prepare('SELECT * FROM revenues WHERE id = ?').get(key);
    if (r) rows = r.order_code ? db.prepare('SELECT * FROM revenues WHERE order_code = ? ORDER BY id').all(r.order_code) : [r];
  } else {
    rows = db.prepare('SELECT * FROM revenues WHERE order_code = ? ORDER BY id').all(key);
  }
  if (!rows.length) return next();
  const en = req.query.lang === 'en';
  const first = rows[0];
  const items = rows.map(r => {
    // "Tên hàng — SN: 123" -> tên + ghi chú serial; "Tên x2" -> số lượng 2
    let [name, sn] = String(r.content || '').split(/\s+—\s+SN:\s+/);
    let qty = 1;
    const m = name.match(/^(.*\S)\s+x(\d{1,2})$/);
    if (m) { name = m[1]; qty = Number(m[2]); }
    if (en) name = name.replace(/\((New|2nd|Like New|Tray New)\)$/i, (x, c) => `(${COND_EN_SALE[c.toLowerCase()] || c})`);
    return { label: name, qty, price: Math.round(r.amount / qty), amount: r.amount, warranty_months: r.warranty_months || null, note: sn ? `SN: ${sn}` : '' };
  });
  const total = items.reduce((s, l) => s + l.amount, 0);
  const build = first.order_code ? db.prepare('SELECT code, name FROM pc_builds WHERE order_code = ?').get(first.order_code) : null;
  const d = new Date(new Date(first.created_at).getTime() + 7 * 3600e3);
  const dateText = en
    ? `Da Nang, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
    : `Đà Nẵng, Ngày ${d.getUTCDate()} Tháng ${d.getUTCMonth() + 1} Năm ${d.getUTCFullYear()}`;
  const settings = require('../../services/settings');
  const DEF = require('../manager/pcParts');
  const b = {
      code: first.order_code || `BH-${first.id}`, name: build ? `Cấu hình ${build.code}${build.name ? ' — ' + build.name : ''}` : '',
      customer_name: first.customer_name, customer_phone: first.customer_phone, customer_addr: first.delivery_address,
      payment: en ? { cash: 'Cash', transfer: 'Bank transfer', debt: 'On credit' }[first.payment_method] : fmt.payment(first.payment_method),
      // Đơn công nợ: hiện số đã trả lúc mua + còn nợ của đơn
      ...(() => {
        if (first.payment_method !== 'debt' || !first.order_code) return { deposit: 0 };
        const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM debt_payments WHERE order_code = ?').get(first.order_code).s;
        return paid ? { deposit: paid, depLabel: en ? 'Paid' : 'Đã trả', remLabel: en ? 'Owing' : 'Còn nợ' } : { deposit: 0 };
      })(),
      discount: 0, total, note: null,
  };
  const printNote = en ? settings.get('pc_print_note_en') || DEF.DEFAULT_NOTE_EN : settings.get('pc_print_note_vi') || DEF.DEFAULT_NOTE_VI;
  // Khổ 80mm (máy in bill): mẫu riêng, kèm thông tin máy nếu là phiếu trả máy
  if (await require('./print').previewPaper(req, `/staff/sell/receipt/${key}`) === '80') { // xem trước đúng mẫu sẽ in ra
    const rep = rows.find(r => r.type === 'repair' && r.ref_id);
    const task = rep ? db.prepare('SELECT ticket_code, device_model, repair_detail, replaced_parts, created_at, completed_at FROM tasks WHERE id = ?').get(rep.ref_id) : null;
    return res.render('staff/receipt_80', { b, items, total, en, task, printNote, staffName: first.staff_name || '', createdAt: first.created_at });
  }
  res.render('staff/build_print', {
    b,
    items, subtotal: total, en, doc: 'receipt', dateText, docToggle: false,
    words: en ? pc.enWords(total) : pc.vnWords(total),
    remainingWords: en ? pc.enWords(total) : pc.vnWords(total), // phiếu bán: "bằng chữ" luôn là tổng tiền đơn
    printNote,
    staffName: first.staff_name || '',
  });
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
