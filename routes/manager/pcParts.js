'use strict';
// Báo giá linh kiện (Build PC): thêm / sửa / xóa, AI tra thông số, ghép kho
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const pc = require('../../services/pcParts');
const pcAi = require('../../services/pcPartsAi');
const ai = require('../../services/aiService');
const settings = require('../../services/settings');
const { notify } = require('../../services/events');

const router = express.Router();
const nav = (req, res, next) => { res.locals.nav = 'm-pc-parts'; next(); };

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const categories = () => db.prepare('SELECT category, MIN(sort) s FROM pc_parts GROUP BY category ORDER BY s').all().map(r => r.category);

// ---------- Danh sách ----------
router.get('/pc-parts', nav, (req, res) => {
  const f = {
    q: String(req.query.q || '').trim(),
    cat: String(req.query.cat || ''),
    stock: ['in', 'out'].includes(req.query.stock) ? req.query.stock : '',
    info: ['none', 'has'].includes(req.query.info) ? req.query.info : '',
  };
  const { byPart, unlinked } = pc.stockInfo();
  let parts = db.prepare('SELECT * FROM pc_parts ORDER BY sort, id').all().map(p => ({ ...p, stock: byPart.get(p.id)?.qty || 0, specsObj: parseJson(p.specs, {}) }));
  const totals = { all: parts.length, in: parts.filter(p => p.stock).length, noInfo: parts.filter(p => !p.ai_at).length, noPrice: parts.filter(p => p.price == null).length };
  if (f.q) { const q = pc.vn(f.q); parts = parts.filter(p => pc.vn(`${p.name} ${p.category} ${p.condition || ''}`).includes(q)); }
  if (f.cat) parts = parts.filter(p => p.category === f.cat);
  if (f.stock) parts = parts.filter(p => (f.stock === 'in' ? p.stock > 0 : !p.stock));
  if (f.info) parts = parts.filter(p => (f.info === 'none' ? !p.ai_at : p.ai_at));
  const groups = [];
  for (const p of parts) {
    let g = groups[groups.length - 1];
    if (!g || g.category !== p.category) { g = { category: p.category, items: [] }; groups.push(g); }
    g.items.push(p);
  }
  res.render('manager/pc_parts', {
    title: 'Báo giá linh kiện', groups, f, totals, cats: categories(), unlinkedCount: unlinked.length,
    aiEnabled: ai.isEnabled(), aiStatus: pcAi.status(), fieldsByType: pc.FIELDS, typeOf: pc.typeOf,
    printNote: { vi: settings.get('pc_print_note_vi') || DEFAULT_NOTE_VI, en: settings.get('pc_print_note_en') || DEFAULT_NOTE_EN },
    scripts: ['/js/pc-parts.js'],
  });
});

// ---------- Thêm / sửa ----------
const partSchema = v.z.object({
  category: v.reqText('Chọn hoặc nhập nhóm linh kiện', 60),
  name: v.reqText('Nhập tên linh kiện', 300),
  condition: v.text(40),
  price: v.money,
  warranty_months: v.intOpt,
  note: v.text(1000),
  note_public: v.text(300),
  summary: v.text(1000),
  hidden: v.z.preprocess(x => (x === '1' || x === 'on' || x === true ? 1 : 0), v.z.number()),
});

function specsFromBody(body, category) {
  const out = {};
  for (const [k] of pc.fieldsOf(category)) {
    const val = String(body[`spec_${k}`] ?? '').trim().slice(0, 200);
    if (val) out[k] = val;
  }
  return out;
}

function formData(part) {
  return {
    title: part.id ? `Sửa: ${part.name}` : 'Thêm linh kiện', part, cats: categories(), aiEnabled: ai.isEnabled(),
    fields: pc.FIELDS, types: pc.TYPES_SRC, specs: parseJson(part.specs, {}), sources: parseJson(part.sources, []),
    units: part.id ? pc.stockUnits(part.id) : [], scripts: ['/js/pc-parts.js'],
  };
}

router.get('/pc-parts/new', nav, (req, res) => {
  res.render('manager/pc_part_edit', formData({ category: String(req.query.cat || ''), name: '', condition: 'New', hidden: 0 }));
});

router.get('/pc-parts/:id', nav, (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const part = db.prepare('SELECT * FROM pc_parts WHERE id = ?').get(req.params.id);
  if (!part) return next();
  res.render('manager/pc_part_edit', formData(part));
});

function savePart(req, res, id) {
  const { data, error } = v.parse(partSchema, req.body);
  const back = id ? `/manager/pc-parts/${id}` : '/manager/pc-parts/new';
  if (error) { req.flash('error', error); return res.redirect(back); }
  const key = pc.matchKey(data.category, data.name, data.condition);
  const dup = db.prepare('SELECT id FROM pc_parts WHERE match_key = ? AND id IS NOT ?').get(key, id || null);
  if (dup) { req.flash('error', 'Đã có linh kiện cùng nhóm, tên và tình trạng này.'); return res.redirect(back); }
  const row = { ...data, match_key: key, specs: JSON.stringify(specsFromBody(req.body, data.category)) };
  if (id) {
    db.prepare(`UPDATE pc_parts SET category=@category, name=@name, condition=@condition, price=@price, warranty_months=@warranty_months, note=@note,
        note_public=@note_public, summary=@summary, hidden=@hidden, specs=@specs, match_key=@match_key,
        ai_at = CASE WHEN @ai_sources IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE ai_at END,
        sources = COALESCE(@ai_sources, sources), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`)
      .run({ ...row, id, ai_sources: req.body.ai_sources || null });
  } else {
    const sort = (db.prepare('SELECT MAX(sort) m FROM pc_parts WHERE category = ?').get(data.category).m ?? db.prepare('SELECT MAX(sort) m FROM pc_parts').get().m ?? 0) + 0.5;
    id = db.prepare(`INSERT INTO pc_parts (category, name, condition, price, warranty_months, note, note_public, summary, hidden, specs, match_key, sort, sources, ai_at)
        VALUES (@category, @name, @condition, @price, @warranty_months, @note, @note_public, @summary, @hidden, @specs, @match_key, @sort, @sources, @ai_at)`)
      .run({ ...row, sort, sources: req.body.ai_sources || null, ai_at: req.body.ai_sources ? new Date().toISOString() : null }).lastInsertRowid;
    if (req.body.inv_name) pc.link(req.body.inv_name, id); // tạo từ "hàng kho chưa có trong báo giá"
  }
  pc.autoLink();
  req.flash('success', `Đã lưu "${pc.displayName(data)}".`);
  res.redirect(req.body.inv_name ? '/manager/pc-parts/stock' : `/manager/pc-parts?cat=${encodeURIComponent(data.category)}#p${id}`);
}
router.post('/pc-parts', (req, res) => savePart(req, res, null));
router.post('/pc-parts/:id', (req, res, next) => (/^\d+$/.test(req.params.id) ? savePart(req, res, Number(req.params.id)) : next()));

router.post('/pc-parts/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM pc_parts WHERE id = ?').get(req.params.id);
  if (p) db.prepare('DELETE FROM pc_parts WHERE id = ?').run(p.id); // liên kết kho tự xóa theo (ON DELETE CASCADE); cấu hình đã lưu giữ bản chụp
  req.flash('success', p ? `Đã xóa "${pc.displayName(p)}".` : 'Linh kiện không còn.');
  res.redirect(`/manager/pc-parts${p ? '?cat=' + encodeURIComponent(p.category) : ''}`);
});

// Sửa giá nhanh trên danh sách (JSON)
router.post('/pc-parts/:id/price', (req, res) => {
  const { data, error } = v.parse(v.z.object({ price: v.money }), req.body);
  if (error) return res.status(422).json({ error });
  const r = db.prepare(`UPDATE pc_parts SET price = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(data.price, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Không tìm thấy linh kiện' });
  res.json({ ok: true, price: data.price });
});

router.post('/pc-parts/:id/toggle-hidden', (req, res) => {
  db.prepare('UPDATE pc_parts SET hidden = 1 - hidden WHERE id = ?').run(req.params.id);
  res.redirect(req.get('Referrer') || '/manager/pc-parts');
});

// ---------- AI ----------
router.post('/api/pc-parts/ai', async (req, res, next) => {
  try {
    const { data, error } = v.parse(v.z.object({ name: v.reqText('Nhập tên linh kiện trước', 300), category: v.reqText('Chọn nhóm trước', 60), condition: v.text(40) }), req.body);
    if (error) return res.status(422).json({ error });
    const t0 = Date.now();
    const r = await pcAi.research(data);
    res.json({ ...r, took: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    if (/\b429\b|RESOURCE_EXHAUSTED/i.test(String(e.status || e.message))) return res.status(429).json({ error: 'Gemini đang hết lượt miễn phí, thử lại sau.' });
    next(e);
  }
});
router.post('/pc-parts/ai-batch/start', (req, res) => { pcAi.start(); res.json(pcAi.status()); });
router.post('/pc-parts/ai-batch/stop', (req, res) => { pcAi.stop(); res.json(pcAi.status()); });
router.get('/pc-parts/ai-batch/status', (req, res) => res.json(pcAi.status()));

// ---------- Ghép kho ----------
router.get('/pc-parts/stock', nav, (req, res) => {
  const parts = db.prepare('SELECT id, category, name, condition, price FROM pc_parts ORDER BY sort, id').all();
  const { unlinked } = pc.stockInfo();
  const rows = unlinked.map(u => ({ ...u, suggestions: pc.suggest(u.name, u.condition, parts).map(s => ({ ...s.part, score: s.score })) }));
  const partById = new Map(parts.map(p => [p.id, p]));
  const links = db.prepare('SELECT * FROM pc_part_links ORDER BY created_at DESC').all().map(l => ({ ...l, part: partById.get(l.part_id) }));
  res.render('manager/pc_parts_stock', { title: 'Ghép kho với báo giá', rows, parts, links, cats: categories(), scripts: ['/js/pc-parts.js'] });
});

router.post('/pc-parts/link', (req, res) => {
  const inv = String(req.body.inv_name || '').trim();
  if (!inv) { req.flash('error', 'Thiếu tên hàng kho.'); return res.redirect('/manager/pc-parts/stock'); }
  if (req.body.ignore) { pc.link(inv, null); req.flash('success', `Đã bỏ qua "${inv}" (không phải linh kiện PC).`); return res.redirect('/manager/pc-parts/stock'); }
  const part = db.prepare('SELECT * FROM pc_parts WHERE id = ?').get(Number(req.body.part_id));
  if (!part) { req.flash('error', 'Chọn món trong báo giá để ghép.'); return res.redirect('/manager/pc-parts/stock'); }
  pc.link(inv, part.id);
  req.flash('success', `Đã ghép "${inv}" → "${pc.displayName(part)}".`);
  res.redirect('/manager/pc-parts/stock');
});

router.post('/pc-parts/unlink', (req, res) => {
  db.prepare('DELETE FROM pc_part_links WHERE inv_key = ?').run(String(req.body.inv_key || ''));
  req.flash('success', 'Đã bỏ ghép.');
  res.redirect('/manager/pc-parts/stock#links');
});

// "Thêm vào báo giá" từ hàng kho: mở form thêm, điền sẵn
router.get('/pc-parts/from-stock', nav, (req, res) => {
  const name = String(req.query.inv_name || '');
  const g = db.prepare(`SELECT name, MAX(condition) condition, MAX(retail_price) price, MAX(warranty_out_months) w FROM inventory_items WHERE status = 'in_stock' AND name = ?`).get(name);
  const cond = pc.condKind(g && g.condition) === 'used' ? '2nd' : 'New';
  res.render('manager/pc_part_edit', { ...formData({ category: '', name, condition: cond, price: g?.price ?? null, warranty_months: g?.w ?? null, hidden: 0 }), invName: name });
});

// ---------- Lưu ý in phiếu ----------
const DEFAULT_NOTE_VI = '1) Các linh kiện, thiết bị NEW được bảo hành theo chính sách của hãng, thời gian ghi ở trên và tem trên sản phẩm.\n2) Linh kiện đã qua sử dụng (2nd / Like New) được bảo hành theo thời gian ghi ở trên. Không bảo hành khi tem bị rách, sản phẩm bị va đập, cháy nổ, vào nước.';
const DEFAULT_NOTE_EN = '1) New components are covered by the manufacturer\'s warranty for the period stated above and on the product label.\n2) Used components (2nd / Like New) are covered for the period stated above. Warranty is void if the seal is broken or the product is physically damaged, burnt or exposed to liquid.';
router.post('/pc-parts/print-note', (req, res) => {
  settings.set({ pc_print_note_vi: String(req.body.note_vi || '').slice(0, 3000), pc_print_note_en: String(req.body.note_en || '').slice(0, 3000) });
  req.flash('success', 'Đã lưu lưu ý in trên phiếu.');
  res.redirect('/manager/pc-parts#print-note');
});

module.exports = router;
module.exports.DEFAULT_NOTE_VI = DEFAULT_NOTE_VI;
module.exports.DEFAULT_NOTE_EN = DEFAULT_NOTE_EN;
