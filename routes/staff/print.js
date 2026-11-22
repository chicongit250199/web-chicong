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

// In phiếu (nhận máy / thanh toán - bảo hành / báo giá) ra máy in NUC: Chrome headless dựng trang thành PDF -> CUPS
const PRINTABLE = /^\/staff\/(tasks\/\d+\/print|sell\/receipt\/[\w-]{1,40}|build\/\d+\/print)(\?(lang=(vi|en)|doc=(quote|receipt))(&(lang=(vi|en)|doc=(quote|receipt)))*)?$/;
router.post('/print/page', async (req, res) => {
  const urlPath = String(req.body.path || '');
  if (!PRINTABLE.test(urlPath)) return res.status(400).json({ error: 'Trang này không in ra máy in cửa hàng được.' });
  try {
    const st = await printers.status();
    const ready = st.printers.filter(p => p.state !== 'disabled');
    const name = req.body.printer && ready.some(p => p.name === req.body.printer) ? req.body.printer : (ready.find(p => p.isDefault) || ready[0] || {}).name;
    if (!name) throw new Error('Chưa có máy in nào sẵn sàng — báo quản lý.');
    const pdf = await require('../../services/pagePdf').render(urlPath, req.get('cookie'));
    const title = `${String(req.body.title || 'Phiếu').slice(0, 80)} (${req.user.full_name})`;
    const job = await printers.printFile(name, { mimetype: 'application/pdf', buffer: Buffer.from(pdf), originalname: title }, { copies: req.body.copies, fit: false, title });
    console.log(`[print] ${req.user.full_name} in phiếu ${urlPath} ra ${name}`);
    const pr = st.printers.find(p => p.name === name);
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
