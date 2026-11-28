'use strict';
// Báo cáo cấu hình máy (script "Kiểm tra cấu hình máy" gửi lên qua /shel/report): chọn khi nhận máy / gắn vào task
const express = require('express');
const db = require('../../db');
const pcReports = require('../../services/pcReports');

const router = express.Router();

router.get('/pc-reports.json', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ items: pcReports.recent() });
});

// Gắn báo cáo vào task; task chưa có cấu hình (và còn sửa được) thì điền luôn
router.post('/tasks/:id/pc-report', (req, res) => {
  try {
    const task = db.prepare('SELECT id, specs, status FROM tasks WHERE id = ?').get(Number(req.params.id));
    if (!task) throw new Error('Không thấy task');
    const r = pcReports.link(Number(req.body.report_id), task.id);
    let filled = false;
    if (!String(task.specs || '').trim() && ['pending', 'processing'].includes(task.status)) {
      db.prepare('UPDATE tasks SET specs = ?, updated_at = ? WHERE id = ?').run(r.summary, new Date().toISOString(), task.id);
      filled = true;
    }
    res.json({ ok: true, filled });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
