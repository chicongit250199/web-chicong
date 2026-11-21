'use strict';
const express = require('express');
const systemInfo = require('../../services/systemInfo');
const vatSync = require('../../services/vatSync');

const router = express.Router();

router.get('/system', (req, res) => {
  res.locals.nav = 'm-system';
  res.render('manager/system', { title: 'Hệ thống', scripts: ['/js/system.js'] });
});

router.get('/system.json', (req, res) => {
  const s = systemInfo.snapshot();
  const st = vatSync.status();
  s.vat = { auto: st.auto, running: Boolean(st.job && st.job.running), job: st.job && { direction: st.job.direction, processed: st.job.processed, total: st.job.total } };
  res.set('Cache-Control', 'no-store').json(s);
});

// Đo tốc độ Internet (chạy nền ~5–20 giây, trang tự hỏi lại kết quả qua system.json)
router.post('/system/speedtest', (req, res) => {
  systemInfo.runSpeedTest(); // không chờ
  res.json(systemInfo.speedStatus());
});

module.exports = router;
