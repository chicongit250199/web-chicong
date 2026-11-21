'use strict';
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const appShell = require('../../middleware/appShell');

const router = express.Router();
router.use(requireRole('staff')); // manager cũng dùng được
router.use(appShell);

router.use(require('./tasks'));
router.use(require('./sales'));
router.use(require('./inventory'));
router.use(require('./products'));
router.use(require('./build'));

module.exports = router;
