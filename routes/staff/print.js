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
  res.render('staff/print', { title: 'In tài liệu', scripts: ['/js/print.js'], p: await view() });
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
const PRINT_QUERY = { lang: /^(vi|en)$/, doc: /^(quote|receipt)$/, paper: /^80$/ };
const DOC_KINDS = { intake: 'Phiếu nhận máy', return: 'Phiếu trả máy (thanh toán sửa chữa)', sale: 'Phiếu bán hàng', quote: 'Báo giá Build PC' };
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
    const title = `${String(req.body.title || 'Phiếu').slice(0, 80)} (${req.user.full_name})`;
    const pagePdf = require('../../services/pagePdf');
    let job;
    if (thermal) {
      p.query.set('paper', '80');
      const png = await pagePdf.screenshot(`${p.base}?${p.query}`, req.get('cookie'), 576, 2);
      const data = await require('../../services/escpos').fromPng(Buffer.from(png));
      job = await printers.printRaw(name, data, { copies: req.body.copies, title });
    } else {
      const qs = p.query.toString();
      const pdf = await pagePdf.render(p.base + (qs ? '?' + qs : ''), req.get('cookie'));
      job = await printers.printFile(name, { mimetype: 'application/pdf', buffer: Buffer.from(pdf), originalname: title }, { copies: req.body.copies, fit: false, title });
    }
    console.log(`[print] ${req.user.full_name} in ${DOC_KINDS[kind]} ${p.base} ra ${name}${thermal ? ' (80mm)' : ''}`);
    res.json({ ok: true, job, printer: (pr && pr.info) || name });
  } catch (e) {
    console.error('[print] in phiếu lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/print/jobs/:id/cancel', async (req, res) => {
  try { await printers.cancelJob(req.params.id); res.json(await view()); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

module.exports = router;
module.exports.DOC_KINDS = DOC_KINDS;
module.exports.THERMAL_KINDS = THERMAL_KINDS;
