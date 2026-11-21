'use strict';
// Sao lưu thủ công: npm run backup
const db = require('../db');
require('../services/backup').backup(db).then(f => { console.log('Đã sao lưu:', f); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
