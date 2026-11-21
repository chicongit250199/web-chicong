'use strict';
const express = require('express');
const systemInfo = require('../../services/systemInfo');
const vatSync = require('../../services/vatSync');
const offsite = require('../../services/offsiteBackup');
const gitBackup = require('../../services/gitBackup');
const db = require('../../db');
const { backup } = require('../../services/backup');

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

// ---------- Sao lưu lên GitHub (mã hóa) ----------
router.get('/system/git-backup', (req, res) => res.set('Cache-Control', 'no-store').json(gitBackup.status()));
router.post('/system/git-backup/run', async (req, res, next) => {
  try {
    await backup(db);
    const r = await gitBackup.run('manual');
    res.json({ ...gitBackup.status(), result: r });
  } catch (e) { next(e); }
});
// Xem mật khẩu giải mã (chỉ quản lý — cả router này đã yêu cầu quyền manager)
router.post('/system/git-backup/passphrase', (req, res) => res.set('Cache-Control', 'no-store').json({ passphrase: gitBackup.passphrase() }));

// ---------- Sao lưu lên Google Drive ----------
router.get('/system/offsite', (req, res) => res.set('Cache-Control', 'no-store').json(offsite.status()));
router.post('/system/offsite/connect', async (req, res, next) => {
  try { res.json(await offsite.startConnect()); } catch (e) { next(e); }
});
router.get('/system/offsite/poll', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await offsite.pollConnect()); } catch (e) { next(e); }
});
router.post('/system/offsite/disconnect', (req, res) => { offsite.disconnect(); res.json(offsite.status()); });
// Sao lưu ngay: tạo bản mới trên máy rồi đẩy lên Drive
router.post('/system/offsite/run', async (req, res, next) => {
  try {
    await backup(db);
    const r = await offsite.run('manual');
    res.json({ ...offsite.status(), result: r });
  } catch (e) { next(e); }
});

module.exports = router;
