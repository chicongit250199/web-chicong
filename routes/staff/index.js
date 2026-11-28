'use strict';
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const appShell = require('../../middleware/appShell');

const router = express.Router();
router.use(requireRole('staff')); // manager cũng dùng được
// Thông báo (SSE / JSON) không cần dữ liệu khung trang
router.use(require('./notifications'));
router.use(appShell);

router.use(require('./tasks'));
router.use(require('./sales'));
router.use(require('./inventory'));
router.use(require('./icParts'));
router.use(require('./products'));
router.use(require('./build'));
router.use(require('./pcParts'));
router.use(require('./partners'));
router.use(require('./debts'));
router.use(require('./print'));

module.exports = router;
