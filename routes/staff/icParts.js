'use strict';
// Quản lý IC (tab trong Quản lý kho): IC đang có để thay khi sửa chữa — không bán.
// Nhân viên & quản lý đều được thêm / sửa / xóa / đổi số lượng.
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const ai = require('../../services/aiService');

const router = express.Router();
const nav = (req, res, next) => { res.locals.nav = 'ic'; next(); };
const now = () => new Date().toISOString();

const schema = v.z.object({
  code: v.reqText('Nhập mã IC', 80),
  marking: v.text(120),
  qty: v.z.preprocess(x => (x === '' || x == null ? 0 : Number(x)), v.z.number().int('Số lượng phải là số nguyên').min(0, 'Số lượng không âm').max(100000)),
  note: v.text(500),
  function: v.text(300),
  datasheet_url: v.z.preprocess(x => (x == null ? '' : String(x).trim()), v.z.string().max(1000)
    .refine(x => !x || /^https?:\/\/\S+$/i.test(x), 'Link datasheet phải bắt đầu bằng http:// hoặc https://')),
});
const clean = d => ({ ...d, marking: d.marking || null, note: d.note || null, function: d.function || null, datasheet_url: d.datasheet_url || null });
const back = req => {
  const q = String(req.body.back || '');
  return q.startsWith('/staff/ic') ? q : '/staff/ic';
};
const sameCode = (code, exceptId) => db.prepare('SELECT id, code FROM ic_parts WHERE lower(trim(code)) = lower(trim(?)) AND id <> ?').get(code, exceptId || 0);

router.get('/ic', nav, (req, res) => {
  const s = String(req.query.q || '').trim();
  const filter = req.query.f === 'out' ? 'out' : '';
  const where = [];
  if (s) where.push(`(vn(code) LIKE @s OR vn(marking) LIKE @s OR vn(note) LIKE @s OR vn(function) LIKE @s)`);
  if (filter === 'out') where.push('qty = 0');
  const items = db.prepare(`SELECT i.*, u.full_name AS updated_name FROM ic_parts i LEFT JOIN users u ON u.id = i.updated_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.code COLLATE NOCASE`).all({ s: `%${db.vn(s)}%` });
  const sum = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(qty),0) total, SUM(qty = 0) out FROM ic_parts').get();
  res.render('staff/ic_parts', { title: 'Quản lý IC', items, search: s, filter, sum, aiEnabled: ai.isEnabled() });
});

router.post('/ic', (req, res) => {
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect(back(req)); }
  const dup = sameCode(data.code);
  if (dup) { req.flash('error', `Đã có IC "${dup.code}" — sửa số lượng ở dòng đó.`); return res.redirect('/staff/ic?q=' + encodeURIComponent(dup.code)); }
  db.prepare(`INSERT INTO ic_parts (code, marking, qty, note, function, datasheet_url, created_at, updated_at, updated_by)
    VALUES (@code, @marking, @qty, @note, @function, @datasheet_url, @t, @t, @u)`).run({ ...clean(data), t: now(), u: req.user.id });
  req.flash('success', `Đã thêm IC "${data.code}" (SL ${data.qty}).`);
  res.redirect(back(req));
});

// Kiểm tra link datasheet AI đưa có mở được thật không (AI hay đoán đường dẫn sai).
// ok: PDF, hoặc trang web có nhắc tới mã IC · blocked: trang chặn máy chủ (vẫn có thể mở được trên trình duyệt)
async function checkUrl(url, code) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
    const type = r.headers.get('content-type') || '';
    if ([401, 403, 429].includes(r.status)) { r.body && r.body.cancel().catch(() => {}); return 'blocked'; }
    if (!r.ok) { r.body && r.body.cancel().catch(() => {}); return 'bad'; }
    if (/pdf|octet-stream/i.test(type)) { r.body && r.body.cancel().catch(() => {}); return 'ok'; }
    const html = (await r.text()).slice(0, 400000);
    if (/<title>\s*(Client Challenge|Just a moment|Attention Required)/i.test(html)) return 'blocked';
    const core = code.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
    return core.length >= 3 && html.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(core) ? 'ok' : 'bad';
  } catch { return 'bad'; }
}

// AI (Gemini + Google Search) tìm chức năng + link datasheet — chỉ gợi ý, người dùng xem lại rồi bấm Lưu
router.post('/ic/ai', async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim().slice(0, 80);
  if (code.length < 2) return res.status(422).json({ error: 'Nhập mã IC trước' });
  try {
    const r = await ai.researchIc({ code, marking: String(req.body.marking || '').trim().slice(0, 120), note: String(req.body.note || '').trim().slice(0, 500) });
    let link = '';
    if (r.datasheet_url) link = await checkUrl(r.datasheet_url, code);
    if (link === 'bad') r.datasheet_url = '';
    res.json({ ...r, link });
  } catch (e) {
    console.error('[ai] ic', e.message);
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(e.message);
    res.status(e.status || 502).json({ error: e.expose ? e.message : quota ? 'Đã hết lượt AI miễn phí hôm nay, thử lại sau.' : 'AI tạm thời không phản hồi, thử lại sau ít phút.' });
  }
});

// ---------- Tra cứu IC (AI): chức năng, datasheet, IC tương đương — tính năng riêng, không thêm vào danh sách ----------
const keyOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// IC trong danh sách khớp 1 mã: trùng hẳn, hoặc mã dài hơn có cùng phần đầu (ISL9238 ~ ISL9238HRTZ), hoặc trùng ký hiệu trên chip
function inStock(code, parts) {
  const k = keyOf(code);
  if (k.length < 3) return [];
  const out = [];
  for (const p of parts) {
    const pk = keyOf(p.code);
    const exact = pk === k || (p.marking && String(p.marking).split(/[,;/]/).some(x => keyOf(x) === k));
    const [a, b] = pk.length < k.length ? [pk, k] : [k, pk];
    // khác hậu tố (ISL9238 / ISL9238A / ISL9238HRTZ): chỉ là mã gần giống, có thể khác biến thể
    if (exact || (a.length >= 5 && b.startsWith(a))) out.push({ id: p.id, code: p.code, qty: p.qty, near: !exact });
  }
  return out.sort((x, y) => x.near - y.near);
}
function withStock(r) {
  const parts = db.prepare('SELECT id, code, marking, qty FROM ic_parts').all();
  const self = new Map();
  for (const c of [r.input, r.code, r.marking]) for (const p of inStock(c, parts)) if (!self.has(p.id) || !p.near) self.set(p.id, p);
  const st = e => ({ ...e, stock: inStock(e.code, parts) });
  return { ...r, stock: [...self.values()].sort((x, y) => x.near - y.near), equivalents: (r.equivalents || []).map(st), candidates: (r.candidates || []).map(st) };
}
const LOOKUP_TTL_DAYS = 90;

router.get('/ic/lookup', nav, (req, res) => {
  const recent = db.prepare(`SELECT l.code, l.created_at, l.hits, json_extract(l.result, '$.function') AS function,
    json_extract(l.result, '$.input') AS input, json_extract(l.result, '$.marking') AS marking, json_extract(l.result, '$.hint') AS hint, json_extract(l.result, '$.code') AS found, u.full_name AS by_name
    FROM ic_lookups l LEFT JOIN users u ON u.id = l.created_by ORDER BY l.created_at DESC LIMIT 30`).all();
  res.render('staff/ic_lookup', { title: 'Tra cứu IC', recent, q: String(req.query.q || '').trim().slice(0, 80),
    m: String(req.query.m || '').trim().slice(0, 80), h: String(req.query.h || '').trim().slice(0, 200), aiEnabled: ai.isEnabled() });
});

router.post('/ic/lookup', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().slice(0, 80);
  const marking = String(b.marking || '').trim().slice(0, 80);
  const hint = String(b.hint || '').trim().slice(0, 200);
  if (keyOf(code).length < 2 && keyOf(marking).length < 2) return res.status(422).json({ error: 'Nhập mã IC hoặc ký hiệu trên chip' });
  const key = keyOf(code) + (marking ? '|' + keyOf(marking) : '') + (hint ? '|' + keyOf(hint) : '');
  const cached = db.prepare('SELECT * FROM ic_lookups WHERE key = ?').get(key);
  const fresh = cached && Date.now() - Date.parse(cached.created_at) < LOOKUP_TTL_DAYS * 864e5;
  if (cached && fresh && !b.refresh) {
    db.prepare('UPDATE ic_lookups SET hits = hits + 1 WHERE id = ?').run(cached.id);
    return res.json(withStock({ ...JSON.parse(cached.result), cached: cached.created_at }));
  }
  try {
    // ký hiệu đã có trong danh sách IC của tiệm -> gợi ý cho AI (thợ đã ghi tay, đáng tin hơn đoán)
    const known = marking ? inStock(marking, db.prepare('SELECT id, code, marking, qty FROM ic_parts').all()).filter(p => !p.near).map(p => p.code) : [];
    const r = await ai.lookupIc({ code, marking, hint, known });
    r.link = r.datasheet_url && (r.code || code) ? await checkUrl(r.datasheet_url, r.code || code) : r.datasheet_url ? 'blocked' : '';
    if (r.link === 'bad') r.datasheet_url = '';
    r.input = code; r.marking = marking; r.hint = hint;
    const t = new Date().toISOString();
    db.prepare(`INSERT INTO ic_lookups (key, code, result, created_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET code = excluded.code, result = excluded.result, created_by = excluded.created_by, created_at = excluded.created_at, hits = hits + 1`)
      .run(key, code || r.code || marking, JSON.stringify(r), req.user.id, t);
    res.json(withStock(r));
  } catch (e) {
    console.error('[ai] ic lookup', e.message);
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(e.message);
    res.status(e.status || 502).json({ error: e.expose ? e.message : quota ? 'Đã hết lượt AI miễn phí hôm nay, thử lại sau.' : 'AI tạm thời không phản hồi, thử lại sau ít phút.' });
  }
});

// Đổi số lượng nhanh (+ / − hoặc gõ số) — JSON
router.post('/ic/:id/qty', (req, res) => {
  const ic = db.prepare('SELECT * FROM ic_parts WHERE id = ?').get(req.params.id);
  if (!ic) return res.status(404).json({ error: 'IC không còn' });
  const b = req.body || {};
  let qty = b.qty != null && b.qty !== '' ? Number(b.qty) : ic.qty + Number(b.delta || 0);
  if (!Number.isInteger(qty)) return res.status(400).json({ error: 'Số lượng không hợp lệ' });
  if (qty < 0) return res.status(400).json({ error: `"${ic.code}" đã hết, không trừ thêm được` });
  if (qty > 100000) return res.status(400).json({ error: 'Số lượng quá lớn' });
  db.prepare('UPDATE ic_parts SET qty = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(qty, now(), req.user.id, ic.id);
  res.json({ ok: true, qty, by: req.user.full_name });
});

router.post('/ic/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const { data, error } = v.parse(schema, req.body);
  if (error) { req.flash('error', error); return res.redirect(back(req)); }
  const dup = sameCode(data.code, Number(req.params.id));
  if (dup) { req.flash('error', `Mã "${data.code}" trùng với IC đã có.`); return res.redirect(back(req)); }
  const r = db.prepare('UPDATE ic_parts SET code=@code, marking=@marking, qty=@qty, note=@note, function=@function, datasheet_url=@datasheet_url, updated_at=@t, updated_by=@u WHERE id=@id')
    .run({ ...clean(data), t: now(), u: req.user.id, id: req.params.id });
  req.flash(r.changes ? 'success' : 'error', r.changes ? `Đã lưu IC "${data.code}".` : 'IC không còn.');
  res.redirect(back(req));
});

router.post('/ic/:id/delete', (req, res) => {
  const ic = db.prepare('SELECT code FROM ic_parts WHERE id = ?').get(req.params.id);
  if (ic) db.prepare('DELETE FROM ic_parts WHERE id = ?').run(req.params.id);
  req.flash('success', ic ? `Đã xóa IC "${ic.code}".` : 'IC không còn.');
  res.redirect(back(req));
});

module.exports = router;
