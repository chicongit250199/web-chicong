'use strict';
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const appShell = require('../../middleware/appShell');

const router = express.Router();
router.use(requireRole('manager'));
// SSE không cần dữ liệu khung trang
router.use((req, res, next) => (req.path === '/events' || req.path === '/system.json' || req.path === '/notifications.json' ? next() : appShell(req, res, next)));

router.use(require('./revenue'));
router.use(require('./debts'));
router.use(require('./expenses'));
router.use(require('./users'));
router.use(require('./assign'));
router.use(require('./homepage'));
router.use(require('./products'));
router.use(require('./import'));
router.use(require('./importRevenue'));
router.use(require('./importPcParts'));
router.use(require('./pcParts'));
router.use(require('./vat'));
router.use(require('./system'));

module.exports = router;
