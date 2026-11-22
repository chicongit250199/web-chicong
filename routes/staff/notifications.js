'use strict';
// Thông báo real-time cho nhân viên: chỉ loại audience = 'all' (bán hàng, sửa chữa, nhập kho), đánh dấu đọc riêng từng người
const express = require('express');
const db = require('../../db');
const events = require('../../services/events');
const { notifData } = require('../../middleware/appShell');

const router = express.Router();
const markSeen = db.prepare(`UPDATE users SET notif_seen_id = MAX(notif_seen_id,
  COALESCE((SELECT MAX(id) FROM notifications WHERE audience = 'all'), 0)) WHERE id = ?`);

router.get('/events', events.stream);
router.get('/notifications.json', (req, res) => res.json(notifData(req.user)));
router.post('/notifications/read', (req, res) => {
  markSeen.run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
