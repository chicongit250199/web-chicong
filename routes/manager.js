'use strict';
const express = require('express');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('manager'));

// Bố cục 3 cột + thống kê sẽ hoàn thiện ở giai đoạn 5
router.get('/', (req, res) => {
  res.render('manager/index', { title: 'Quản lý' });
});

module.exports = router;
