'use strict';
const express = require('express');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('staff'));

// Bảng Task 2 cột sẽ hoàn thiện ở giai đoạn 3
router.get('/', (req, res) => {
  res.render('staff/index', { title: 'Nhân viên' });
});

module.exports = router;
