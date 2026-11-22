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

router.post('/print/jobs/:id/cancel', async (req, res) => {
  try { await printers.cancelJob(req.params.id); res.json(await view()); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

module.exports = router;
