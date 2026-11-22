'use strict';
const express = require('express');
const systemInfo = require('../../services/systemInfo');
const vatSync = require('../../services/vatSync');
const offsite = require('../../services/offsiteBackup');
const gitBackup = require('../../services/gitBackup');
const revenueReport = require('../../services/revenueReport');
const taskAlerts = require('../../services/taskAlerts');
const printers = require('../../services/printers');
const { fileUpload } = require('../../services/upload');
const serverLog = require('../../services/serverLog');
const db = require('../../db');
const settings = require('../../services/settings');
const { backup } = require('../../services/backup');

const router = express.Router();

router.get('/system', (req, res) => {
  res.locals.nav = 'm-system';
  const DEF = require('./pcParts');
  const tab = ['printers', 'settings', 'backup'].includes(req.query.tab) ? req.query.tab : 'overview';
  res.render('manager/system', {
    title: 'Hệ thống', tab, scripts: ['/js/system.js'], sysUser: require('os').userInfo().username,
    printNote: { vi: settings.get('pc_print_note_vi') || DEF.DEFAULT_NOTE_VI, en: settings.get('pc_print_note_en') || DEF.DEFAULT_NOTE_EN },
  });
});

// Lưu ý in trên phiếu báo giá / thanh toán - bảo hành (Build PC, bán hàng)
router.post('/system/print-note', (req, res) => {
  settings.set({ pc_print_note_vi: String(req.body.note_vi || '').slice(0, 3000), pc_print_note_en: String(req.body.note_en || '').slice(0, 3000) });
  req.flash('success', 'Đã lưu lưu ý in trên phiếu.');
  res.redirect('/manager/system?tab=printers#print-note');
});

router.get('/system.json', (req, res) => {
  const s = systemInfo.snapshot();
  const st = vatSync.status();
  s.vat = { auto: st.auto, running: Boolean(st.job && st.job.running), job: st.job && { direction: st.job.direction, processed: st.job.processed, total: st.job.total } };
  res.set('Cache-Control', 'no-store').json(s);
});

// Console máy chủ (đọc từ log PM2); gửi ?sig= để khỏi tải lại khi log không đổi
router.get('/system/logs', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.sig && req.query.sig === serverLog.signature()) return res.json({ same: true });
  res.json(serverLog.tail(req.query.limit));
});

// Đo tốc độ Internet (chạy nền ~5–20 giây, trang tự hỏi lại kết quả qua system.json)
router.post('/system/speedtest', (req, res) => {
  systemInfo.runSpeedTest(); // không chờ
  res.json(systemInfo.speedStatus());
});

// ---------- Cảnh báo task quá hạn ----------
router.get('/system/task-alerts', (req, res) => res.set('Cache-Control', 'no-store').json(taskAlerts.thresholds()));
router.post('/system/task-alerts', (req, res) => {
  try {
    const t = taskAlerts.setThresholds({ pending: Number(req.body.pending), processing: Number(req.body.processing) });
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Máy in (CUPS) ----------
// Lỗi từ lệnh CUPS -> trả thông báo cho trang (thường là thiếu quyền / máy in không phản hồi)
const pr = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await fn(req)); } catch (e) {
    let msg = e.message || 'Lỗi máy in';
    if (/Forbidden|not authorized|Unauthorized/i.test(msg)) msg = 'Web chưa có quyền quản trị máy in — chạy: sudo usermod -aG lpadmin ' + require('os').userInfo().username;
    res.status(e.status || 400).json({ error: msg });
  }
};
router.get('/system/printers', pr(() => printers.status()));
router.post('/system/printers/discover', pr(() => printers.discover()));
router.get('/system/printers/models', pr(req => printers.models(req.query.q)));
router.post('/system/printers/add', pr(async req => {
  const b = req.body;
  await printers.add({ name: b.name, uri: String(b.uri || '').trim(), driver: b.driver, info: b.info, location: b.location, makeDefault: !!b.makeDefault });
  return printers.status();
}));
router.post('/system/printers/:name/:action', pr(async req => {
  const n = req.params.name;
  switch (req.params.action) {
    case 'default': await printers.setDefault(n); break;
    case 'enable': await printers.setEnabled(n, true); break;
    case 'disable': await printers.setEnabled(n, false); break;
    case 'delete': await printers.remove(n); break;
    case 'cancel-all': await printers.cancelAll(n); break;
    case 'pagesize': await printers.setPageSize(n, String(req.body.size || '')); break;
    case 'share': await printers.setShared(n, true); break;
    case 'unshare': await printers.setShared(n, false); break;
    case 'test': return { job: await printers.testPage(n), ...(await printers.status()) };
    default: throw Object.assign(new Error('Không rõ thao tác'), { status: 404 });
  }
  return printers.status();
}));
router.post('/system/print-jobs/:id/cancel', pr(async req => { await printers.cancelJob(req.params.id); return printers.status(); }));
router.post('/system/print-file', fileUpload(30).single('file'), pr(async req => {
  const job = await printers.printFile(req.body.printer, req.file, { copies: req.body.copies, fit: req.body.fit !== '0', title: `${req.file && req.file.originalname} (${req.user.full_name})` });
  return { job, ...(await printers.status()) };
}));

// ---------- Báo cáo doanh thu qua email ----------
router.get('/system/report-email', (req, res) => res.set('Cache-Control', 'no-store').json(revenueReport.status()));
// Đổi giờ gửi báo cáo hằng ngày
router.post('/system/report-email/time', (req, res) => {
  try { res.json(revenueReport.setTime(req.body.at)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
// ---------- Đồng bộ Google Sheet ----------
const sheetSync = require('../../services/sheetSync');
router.get('/system/gsheet', (req, res) => res.set('Cache-Control', 'no-store').json(sheetSync.status()));
router.post('/system/gsheet', (req, res) => {
  try { res.json(sheetSync.setConfig({ url: req.body.url, from: req.body.from, at: req.body.at })); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.post('/system/gsheet/sync', async (req, res) => {
  try { const r = await sheetSync.sync('manual'); res.json({ ...sheetSync.status(), result: r }); } catch (e) { res.status(400).json({ error: e.message, ...sheetSync.status() }); }
});

// Xem trước nội dung mail trong trình duyệt
router.get('/system/report-email/preview', (req, res) => {
  const r = req.query.kind === 'monthly' ? revenueReport.monthlyReport() : revenueReport.dailyReport();
  res.set('Cache-Control', 'no-store').type('html').send(r.html);
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
