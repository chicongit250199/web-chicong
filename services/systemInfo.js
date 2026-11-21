'use strict';
// Trạng thái máy chủ (NUC): nhiệt độ, CPU, RAM, ổ đĩa, uptime + thông tin ứng dụng. Chỉ đọc /proc, /sys — không cần root.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const read = (p, d = null) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return d; } };

// ---- CPU: % sử dụng tính từ chênh lệch /proc/stat giữa 2 lần đọc ----
function cpuTimes() {
  const lines = (read('/proc/stat', '') || '').split('\n').filter(l => /^cpu\d* /.test(l));
  return lines.map(l => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    return { idle, total };
  });
}
let lastTimes = cpuTimes();
function cpuUsage() {
  const now = cpuTimes();
  const pct = now.map((t, i) => {
    const p = lastTimes[i];
    const dt = t.total - (p ? p.total : 0);
    const di = t.idle - (p ? p.idle : 0);
    return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 1000) / 10)) : 0;
  });
  lastTimes = now;
  return { total: pct[0] || 0, cores: pct.slice(1) };
}

// ---- Nhiệt độ: hwmon (coretemp từng nhân, acpitz bo mạch...) ----
function temperatures() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch { return out; }
  for (const d of dirs) {
    const base = path.join('/sys/class/hwmon', d);
    const chip = read(path.join(base, 'name'), d);
    let files = [];
    try { files = fs.readdirSync(base).filter(f => /^temp\d+_input$/.test(f)); } catch { continue; }
    for (const f of files) {
      const raw = read(path.join(base, f));
      if (raw == null || raw === '') continue;
      const pre = f.replace('_input', '');
      const label = read(path.join(base, `${pre}_label`)) || (chip === 'acpitz' ? 'Bo mạch (ACPI)' : `${chip} ${pre}`);
      const crit = Number(read(path.join(base, `${pre}_crit`))) / 1000 || null;
      out.push({ chip, label: label.replace(/^Core (\d+)$/, 'Nhân $1').replace(/^Package id \d+$/, 'CPU (tổng)'), value: Number(raw) / 1000, crit });
    }
  }
  return out.sort((a, b) => (a.chip === 'coretemp' ? -1 : 1) - (b.chip === 'coretemp' ? -1 : 1) || a.label.localeCompare(b.label, 'vi', { numeric: true }));
}

function memory() {
  const m = {};
  for (const l of (read('/proc/meminfo', '') || '').split('\n')) {
    const [k, v] = l.split(':');
    if (v) m[k] = parseInt(v, 10) * 1024;
  }
  return { total: m.MemTotal || os.totalmem(), available: m.MemAvailable ?? os.freemem(), swapTotal: m.SwapTotal || 0, swapFree: m.SwapFree || 0 };
}

function disk(p) {
  try {
    const s = fs.statfsSync(p);
    return { path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

function dirSize(dir) {
  let total = 0; let count = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile()) { total += fs.statSync(path.join(dir, f.name)).size; count++; }
    }
  } catch { /* thư mục chưa có */ }
  return { total, count };
}

function osName() {
  const m = (read('/etc/os-release', '') || '').match(/^PRETTY_NAME="?([^"\n]+)/m);
  return m ? m[1] : `${os.type()} ${os.release()}`;
}

// ---- Lịch sử 10 phút (lấy mẫu mỗi 10 giây, chạy nền, rất nhẹ) ----
const HISTORY = 60;
const history = [];
function sample(record = true) {
  const c = cpuUsage();
  const temps = temperatures();
  const cpuTemp = Math.max(...temps.filter(t => t.chip === 'coretemp').map(t => t.value), ...(temps.length ? [] : [0]));
  if (record) {
    history.push({ t: Date.now(), cpu: c.total, temp: Number.isFinite(cpuTemp) && cpuTemp > 0 ? cpuTemp : null });
    if (history.length > HISTORY) history.shift();
  }
  return { c, temps };
}
sample();
setInterval(sample, 10000).unref();

function snapshot() {
  const { c, temps } = sample(false);
  const cpus = os.cpus();
  const db = [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm'].reduce((s, f) => {
    try { return s + fs.statSync(f).size; } catch { return s; }
  }, 0);
  const backups = (() => {
    try {
      const files = fs.readdirSync(config.backupDir).filter(f => /\.db$/.test(f)).sort();
      const last = files[files.length - 1];
      return { count: files.length, last: last ? fs.statSync(path.join(config.backupDir, last)).mtime.toISOString() : null };
    } catch { return { count: 0, last: null }; }
  })();
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)).map(i => i.address);
  return {
    time: new Date().toISOString(),
    host: { hostname: os.hostname(), os: osName(), kernel: os.release(), uptime: os.uptime(), ips },
    cpu: { model: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU /g, '').trim(), cores: cpus.length, usage: c.total, perCore: c.cores, load: os.loadavg() },
    temps,
    memory: memory(),
    disks: [disk('/')].filter(Boolean),
    app: {
      node: process.version, pid: process.pid, uptime: process.uptime(), rss: process.memoryUsage().rss,
      manager: process.env.pm_id !== undefined ? 'PM2' : 'thủ công', env: config.isProd ? 'production' : 'development',
      db, uploads: dirSize(config.uploadDir), backups,
    },
    history,
  };
}

module.exports = { snapshot };
