'use strict';
// Sao lưu SQLite an toàn khi đang chạy (online backup API), giữ N bản gần nhất
const fs = require('fs');
const path = require('path');
const config = require('../config');

const KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 14;

async function backup(db) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(config.backupDir, `chicong-${stamp}.db`);
  await db.backup(file);
  const old = fs.readdirSync(config.backupDir).filter(f => /^chicong-.*\.db$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) fs.rmSync(path.join(config.backupDir, f), { force: true });
  return file;
}

// Chạy mỗi ngày lúc BACKUP_HOUR (giờ VN, mặc định 2h sáng)
function schedule(db) {
  const hour = parseInt(process.env.BACKUP_HOUR, 10);
  const h = Number.isFinite(hour) ? hour : 2;
  const next = () => {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 3600e3);
    const target = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate(), h) - 7 * 3600e3);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  };
  const run = () => {
    backup(db).then(f => {
      console.log(`[backup] ${f}`);
      // xong bản trên máy -> đẩy bản mã hóa lên GitHub; Google Drive nếu đã kết nối
      return require('./gitBackup').run('auto').catch(() => {})
        .then(() => require('./offsiteBackup').run('auto').catch(() => {}));
    }).catch(e => console.error('[backup] lỗi', e.message));
    setTimeout(run, next()).unref();
  };
  setTimeout(run, next()).unref();
}

module.exports = { backup, schedule };
