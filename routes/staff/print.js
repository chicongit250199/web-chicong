'use strict';
// In tài liệu từ web: nhân viên tải file (PDF/ảnh/TXT) từ máy tính / điện thoại bất kỳ trong LAN.
// File chỉ nằm trong RAM rồi đẩy thẳng vào hàng đợi CUPS — không lưu lại trên server.
const express = require('express');
const multer = require('multer');
const printers = require('../../services/printers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 10 } });

const view = async () => {
  const s = await printers.status().catch(e => ({ available: false, error: e.message, printers: [], jobs: [] }));
  return { ...s, printers: s.printers.filter(p => p.state !== 'disabled'), all: s.printers };
};

router.get('/print', async (req, res) => {
  res.locals.nav = 'print';
  res.render('staff/print', { title: 'In tài liệu', scripts: ['/js/print.js'], p: await view(), ship: shipInfo() });
});
router.get('/print/status', async (req, res) => res.set('Cache-Control', 'no-store').json(await view()));

router.post('/print', upload.array('files', 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Chưa chọn file.' });
  const opts = { copies: req.body.copies, fit: req.body.fit !== '0', duplex: req.body.duplex === '1' };
  // Máy in tắt / tạm dừng -> báo ngay cho người in, không gửi file nào
  try { await printers.ensureOnline(req.body.printer); } catch (e) {
    for (const f of files) f.buffer = null;
    return res.status(e.status || 400).json({ error: e.message, ...(await view()) });
  }
  const results = [];
  for (const f of files) {
    f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer đọc tên file UTF-8 thành latin1
    try {
      const job = await printers.printFile(req.body.printer, f, { ...opts, title: `${f.originalname} (${req.user.full_name})` });
      results.push({ file: f.originalname, ok: true, job });
    } catch (e) {
      results.push({ file: f.originalname, ok: false, error: e.message });
    }
    f.buffer = null; // nhả RAM ngay
  }
  console.log(`[print] ${req.user.full_name} in ${results.filter(r => r.ok).length}/${files.length} file ra ${req.body.printer}`);
  res.json({ results, ...(await view()) });
});

// In phiếu (nhận máy / thanh toán - bảo hành / báo giá) ra máy in NUC: Chrome headless dựng trang thành PDF -> CUPS.
// Mỗi loại phiếu in ra máy đặt ở trang Hệ thống (settings print_to_*), không đặt thì máy mặc định.
// Máy in bill (Raw, khổ 80mm): dựng mẫu phiếu 80mm (?paper=80) thành ảnh rồi gửi lệnh ESC/POS.
const settings = require('../../services/settings');
const db = require('../../db');
const PRINT_BASE = /^\/staff\/(tasks\/\d+\/print|sell\/receipt\/[\w-]{1,40}|build\/\d+\/print)$/;
const PRINT_QUERY = { lang: /^(vi|en)$/, doc: /^(quote|receipt)$/, paper: /^(80|a4)$/ };
const DOC_KINDS = { intake: 'Phiếu nhận máy', return: 'Phiếu trả máy (thanh toán sửa chữa)', sale: 'Phiếu bán hàng', quote: 'Báo giá Build PC', ship: 'Phiếu gửi hàng' };
const THERMAL_KINDS = new Set(['intake', 'return', 'sale']); // loại phiếu có mẫu 80mm

function cleanPath(raw) {
  const [base, qs = ''] = String(raw || '').split('?');
  if (!PRINT_BASE.test(base)) return null;
  const q = new URLSearchParams(qs), out = new URLSearchParams();
  for (const [k, v] of q) { if (!PRINT_QUERY[k] || !PRINT_QUERY[k].test(v)) return null; if (k !== 'paper') out.set(k, v); }
  return { base, query: out };
}
function docKind(base) {
  if (/^\/staff\/tasks\//.test(base)) return 'intake';
  if (/^\/staff\/build\//.test(base)) return 'quote';
  const key = base.split('/').pop();
  const row = /^\d+$/.test(key) ? db.prepare('SELECT order_code, type, ref_id FROM revenues WHERE id = ?').get(key) : { order_code: key };
  if (!row) return 'sale';
  const rep = row.order_code ? db.prepare(`SELECT 1 FROM revenues WHERE order_code = ? AND type = 'repair' AND ref_id IS NOT NULL LIMIT 1`).get(row.order_code)
    : row.type === 'repair' && row.ref_id;
  return rep ? 'return' : 'sale';
}

// Mẫu xem trước mặc định theo máy in đã chọn cho loại phiếu (Hệ thống → In): máy bill -> 80mm, còn lại A4/A5.
// ?paper=80 / ?paper=a4 ép mẫu. Trạng thái máy in nhớ 30 giây cho đỡ gọi lpstat.
let stCache = { at: 0, p: null };
function cachedStatus() {
  if (!stCache.p || Date.now() - stCache.at > 30000) stCache = { at: Date.now(), p: printers.status().catch(() => ({ printers: [] })) };
  return stCache.p;
}
async function previewPaper(req, base) {
  if (req.query.paper === '80' || req.query.paper === 'a4') return req.query.paper;
  const want = settings.get('print_to_' + docKind(base));
  if (!want) return 'a4';
  const pr = (await cachedStatus()).printers.find(x => x.name === want);
  return pr && printers.isThermal(pr) ? '80' : 'a4';
}

router.post('/print/page', async (req, res) => {
  const p = cleanPath(req.body.path);
  if (!p) return res.status(400).json({ error: 'Trang này không in ra máy in cửa hàng được.' });
  try {
    const kind = docKind(p.base);
    const st = await printers.status();
    const ready = st.printers.filter(x => x.state !== 'disabled');
    const want = settings.get('print_to_' + kind);
    const name = [req.body.printer, want].find(n => n && ready.some(x => x.name === n)) || (ready.find(x => x.isDefault) || ready[0] || {}).name;
    if (!name) throw new Error('Chưa có máy in nào sẵn sàng — báo quản lý.');
    const pr = st.printers.find(x => x.name === name);
    const thermal = printers.isThermal(pr);
    if (thermal && !THERMAL_KINDS.has(kind)) throw new Error(`${DOC_KINDS[kind]} chỉ có mẫu A4 — chọn máy in A4 cho loại phiếu này ở trang Hệ thống.`);
    await printers.ensureOnline(name); // kiểm tra trước khi dựng phiếu (mất vài giây)
    const copies = Math.min(Math.max(parseInt(req.body.copies, 10) || 1, 1), 20); // mặc định 1 bản
    const title = `${String(req.body.title || 'Phiếu').slice(0, 80)} (${req.user.full_name})`;
    const pagePdf = require('../../services/pagePdf');
    let job;
    if (thermal) {
      p.query.set('paper', '80');
      const png = await pagePdf.screenshot(`${p.base}?${p.query}`, req.get('cookie'), 576, 2);
      const data = await require('../../services/escpos').fromPng(Buffer.from(png));
      job = await printers.printRaw(name, data, { copies, title });
    } else {
      p.query.set('paper', 'a4');
      const qs = p.query.toString();
      const pdf = await pagePdf.render(p.base + (qs ? '?' + qs : ''), req.get('cookie'));
      job = await printers.printFile(name, { mimetype: 'application/pdf', buffer: Buffer.from(pdf), originalname: title }, { copies, fit: false, title });
    }
    console.log(`[print] ${req.user.full_name} in ${DOC_KINDS[kind]} ${p.base} ra ${name}${thermal ? ' (80mm)' : ''} × ${copies}`);
    res.json({ ok: true, job, copies: Number(copies), printer: (pr && pr.info) || name });
  } catch (e) {
    console.error('[print] in phiếu lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ---------- Phiếu gửi hàng (A4): nhập người nhận ở trang In tài liệu -> dựng PDF -> máy in A4 (mặc định HP P2035) ----------
const SHIP_FROM_DEFAULT = { from_name: 'CHÍ CÔNG COMPUTER', from_phone: '0763.02.86.86', from_addr: 'K18/9 Phan Tứ, P Ngũ Hành Sơn, TP Đà Nẵng.' };
const SHIP_FIELDS = { to_name: 120, to_phone: 40, to_addr: 300, from_name: 120, from_phone: 40, from_addr: 300 };
function shipLabel(src) {
  const l = {};
  for (const [k, max] of Object.entries(SHIP_FIELDS)) l[k] = String(src[k] || '').replace(/\s+/g, ' ').trim().slice(0, max);
  for (const k of ['from_name', 'from_phone', 'from_addr']) if (!l[k]) l[k] = shipFrom()[k];
  l.fragile = src.fragile === '1' || src.fragile === true || src.fragile === 1;
  return l;
}
function shipFrom() {
  return { from_name: settings.get('ship_from_name') || SHIP_FROM_DEFAULT.from_name,
    from_phone: settings.get('ship_from_phone') || SHIP_FROM_DEFAULT.from_phone,
    from_addr: settings.get('ship_from_addr') || SHIP_FROM_DEFAULT.from_addr };
}
function shipRecent() {
  try { const a = JSON.parse(settings.get('ship_recent') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
const shipInfo = () => ({ from: shipFrom(), recent: shipRecent(),
  partners: db.prepare('SELECT name, phones FROM partners ORDER BY name COLLATE NOCASE').all()
    .map(p => ({ n: p.name, p: String(p.phones || '').split(/[,\n]/)[0].trim() })) });

router.get('/print/ship/label', (req, res) => {
  const l = shipLabel(req.query);
  if (!l.to_name) return res.status(400).send('Thiếu tên người nhận');
  res.render('staff/ship_label', { l, pdf: req.query.pdf === '1' });
});

router.post('/print/ship', async (req, res) => {
  const l = shipLabel(req.body || {});
  if (!l.to_name) return res.status(400).json({ error: 'Nhập tên người nhận.' });
  try {
    const st = await printers.status();
    const ready = st.printers.filter(x => x.state !== 'disabled' && !printers.isThermal(x));
    const want = settings.get('print_to_ship');
    const name = [req.body.printer, want].find(n => n && ready.some(x => x.name === n))
      || (ready.find(x => /2035/.test(x.name + ' ' + (x.info || ''))) || ready.find(x => x.isDefault) || ready[0] || {}).name;
    if (!name) throw new Error('Không có máy in A4 nào sẵn sàng — báo quản lý.');
    const pr = st.printers.find(x => x.name === name);
    await printers.ensureOnline(name);
    const copies = Math.min(Math.max(parseInt(req.body.copies, 10) || 1, 1), 20);
    // nhớ người gửi + danh sách người nhận gần đây (gợi ý lần sau)
    const recent = shipRecent().filter(r => !(r.n === l.to_name && r.p === l.to_phone));
    recent.unshift({ n: l.to_name, p: l.to_phone, a: l.to_addr });
    settings.set({ ship_recent: JSON.stringify(recent.slice(0, 50)), ship_from_name: l.from_name, ship_from_phone: l.from_phone, ship_from_addr: l.from_addr });
    const q = new URLSearchParams({ ...Object.fromEntries(Object.keys(SHIP_FIELDS).map(k => [k, l[k]])), fragile: l.fragile ? '1' : '0', pdf: '1' });
    const pdf = await require('../../services/pagePdf').render('/staff/print/ship/label?' + q, req.get('cookie'));
    const title = `Phiếu gửi hàng ${l.to_name} (${req.user.full_name})`;
    const job = await printers.printFile(name, { mimetype: 'application/pdf', buffer: Buffer.from(pdf), originalname: title }, { copies, fit: false, title });
    console.log(`[print] ${req.user.full_name} in phiếu gửi hàng "${l.to_name}" ra ${name} × ${copies}`);
    res.json({ ok: true, job, copies, printer: (pr && pr.info) || name, ship: shipInfo() });
  } catch (e) {
    console.error('[print] phiếu gửi hàng lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/print/jobs/:id/cancel', async (req, res) => {
  try { await printers.cancelJob(req.params.id); res.json(await view()); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

module.exports = router;
module.exports.DOC_KINDS = DOC_KINDS;
module.exports.THERMAL_KINDS = THERMAL_KINDS;
module.exports.shipInfo = shipInfo;
module.exports.previewPaper = previewPaper;
