'use strict';
const express = require('express');
const db = require('../db');
const { field } = require('../services/i18n');

const router = express.Router();
const qCats = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, id');

// Trang chủ đầy đủ sẽ hoàn thiện ở giai đoạn 2
router.get('/', (req, res) => {
  res.render('public/index', { title: res.locals.settings.company_name, categories: qCats.all(), field });
});

module.exports = router;
