'use strict';
// Sao lưu ra ngoài máy lên GitHub (nhánh "backup" của repo code, dùng SSH key sẵn có của máy):
// nén CSDL mới nhất + ảnh upload -> mã hóa AES-256 (openssl, PBKDF2) bằng BACKUP_PASSPHRASE -> đẩy lên, giữ N bản gần nhất.
// Nhánh backup luôn chỉ có 1 commit (đẩy đè) để repo không phình theo thời gian.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(path.dirname(config.dbPath), 'git-backup');   // thư mục làm việc riêng (nằm trong data/, ngoài git của code)
const STATE_FILE = path.join(path.dirname(config.dbPath), 'git-backup.json');
const BRANCH = 'backup';
const KEEP = parseInt(process.env.GIT_BACKUP_KEEP, 10) || 7;
const ENC = ['-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-md', 'sha256'];

const passphrase = () => process.env.BACKUP_PASSPHRASE || '';
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { last: null, lastError: null }; } };
let state = readState();
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
let running = false;

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd} ${args.slice(0, 3).join(' ')}: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`; return reject(err); }
      resolve(String(stdout).trim());
    });
  });
}
const git = (args, opts) => sh('git', ['-c', 'user.name=chicong-backup', '-c', 'user.email=backup@localhost', ...args], { cwd: WORK, ...opts });

async function remoteUrl() {
  return process.env.GIT_BACKUP_REMOTE || sh('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
}

const README = `# Sao lưu Chí Công Computer (mã hóa)

Mỗi file \`chicong-YYYY-MM-DD_HHMM.tar.gz.enc\` = CSDL (SQLite) + ảnh upload, mã hóa AES-256.
Mật khẩu: BACKUP_PASSPHRASE (trong file .env trên máy chủ — chủ cửa hàng giữ bản chép riêng).

## Khôi phục (Linux / máy có OpenSSL 1.1.1 trở lên)

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in chicong-....tar.gz.enc -out backup.tar.gz
    tar xzf backup.tar.gz
    # -> chicong.db (đặt vào data/chicong.db) và thư mục uploads/ (chép vào public/uploads/)

Trên Mac nếu lệnh openssl báo không hỗ trợ -pbkdf2: \`brew install openssl\` rồi dùng \`$(brew --prefix openssl)/bin/openssl\`.
`;

async function run(reason = 'auto') {
  if (running) return { skipped: 'Đang chạy' };
  if (!passphrase()) return { skipped: 'Chưa có BACKUP_PASSPHRASE trong .env' };
  running = true;
  const t0 = Date.now();
  const tmp = path.join(WORK, '.tmp');
  try {
    // 1) Thư mục làm việc git riêng, nhánh backup mồ côi
    if (!fs.existsSync(path.join(WORK, '.git'))) {
      fs.mkdirSync(WORK, { recursive: true });
      await git(['init', '-q']);
      await git(['remote', 'add', 'origin', await remoteUrl()]);
      // lấy các bản cũ (nếu nhánh backup đã có trên GitHub, VD sau khi cài lại máy)
      try { await git(['fetch', '-q', '--depth', '1', 'origin', BRANCH]); await git(['checkout', '-q', '-B', BRANCH, 'FETCH_HEAD']); } catch { await git(['checkout', '-q', '--orphan', BRANCH]); }
    }
    // 2) Gói CSDL mới nhất + ảnh upload
    const dbs = fs.existsSync(config.backupDir) ? fs.readdirSync(config.backupDir).filter(f => /^chicong-.*\.db$/.test(f)).sort() : [];
    if (!dbs.length) throw new Error('Chưa có bản sao lưu CSDL trên máy (data/backups)');
    const latest = dbs[dbs.length - 1];
    const stamp = latest.replace(/^chicong-|\.db$/g, '').replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/, '$1_$2$3');
    const name = `chicong-${stamp}.tar.gz.enc`;
    const snapDir = path.join(WORK, 'snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    fs.copyFileSync(path.join(config.backupDir, latest), path.join(tmp, 'chicong.db'));
    const tarFile = path.join(tmp, 'b.tar.gz');
    await sh('tar', ['czf', tarFile, '-C', tmp, 'chicong.db', '-C', path.dirname(config.uploadDir), path.basename(config.uploadDir)]);
    await sh('openssl', ['enc', ...ENC, '-salt', '-in', tarFile, '-out', path.join(snapDir, name), '-pass', 'env:BKPASS'], { env: { ...process.env, BKPASS: passphrase() } });
    // tự kiểm tra: giải mã lại được
    await sh('openssl', ['enc', '-d', ...ENC, '-in', path.join(snapDir, name), '-out', path.join(tmp, 'check.tar.gz'), '-pass', 'env:BKPASS'], { env: { ...process.env, BKPASS: passphrase() } });
    await sh('tar', ['tzf', path.join(tmp, 'check.tar.gz')]);
    fs.rmSync(tmp, { recursive: true, force: true });
    // giữ KEEP bản mới nhất
    const snaps = fs.readdirSync(snapDir).filter(f => f.endsWith('.enc')).sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - KEEP))) fs.rmSync(path.join(snapDir, f));
    fs.writeFileSync(path.join(WORK, 'README.md'), README);

    // 3) Một commit duy nhất, đẩy đè
    await git(['checkout', '-q', '--orphan', 'tmp-backup']);
    await git(['add', '-A', 'README.md', 'snapshots']);
    await git(['commit', '-q', '-m', `Sao lưu ${stamp} (${reason})`]);
    await git(['branch', '-q', '-M', BRANCH]);
    await git(['push', '-q', '-f', 'origin', BRANCH]);
    await git(['gc', '-q', '--prune=now']).catch(() => {});

    const kept = fs.readdirSync(snapDir).filter(f => f.endsWith('.enc')).sort();
    state.last = { at: new Date().toISOString(), reason, file: name, size: fs.statSync(path.join(snapDir, name)).size, kept: kept.length, seconds: Math.round((Date.now() - t0) / 1000) };
    state.lastError = null;
    saveState();
    console.log(`[git-backup] đã đẩy ${name} (${kept.length} bản trên nhánh ${BRANCH})`);
    return state.last;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    state.lastError = { at: new Date().toISOString(), message: e.message };
    saveState();
    console.error('[git-backup] lỗi', e.message);
    throw Object.assign(new Error(e.message), { status: 502, expose: true });
  } finally { running = false; }
}

function status() {
  return { configured: Boolean(passphrase()), last: state.last, lastError: state.lastError, running, keep: KEEP, branch: BRANCH };
}

module.exports = { run, status, passphrase };
