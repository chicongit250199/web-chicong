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
    // Chip Super I/O (nct67xx, it87) trên BRIX báo nhiệt độ ảo (CPUTIN 123°C) → chỉ lấy tốc độ quạt, bỏ nhiệt độ
    if (/^(nct|it87)/.test(chip)) continue;
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

// ---- Quạt: hwmon fan*_input (cần module nct6775). Cổng đọc 0 vòng/phút mà chưa từng quay = không cắm quạt → ẩn ----
const seenFans = new Set();
function fans() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/hwmon'); } catch { return out; }
  for (const d of dirs) {
    const base = path.join('/sys/class/hwmon', d);
    const chip = read(path.join(base, 'name'), d);
    let files = [];
    try { files = fs.readdirSync(base).filter(f => /^fan\d+_input$/.test(f)); } catch { continue; }
    for (const f of files) {
      const rpm = Number(read(path.join(base, f)));
      if (!Number.isFinite(rpm)) continue;
      const n = f.match(/\d+/)[0];
      const key = `${chip}:${n}`;
      if (rpm > 0) seenFans.add(key);
      if (!seenFans.has(key)) continue;
      const pwm = Number(read(path.join(base, `pwm${n}`)));
      out.push({ key, label: read(path.join(base, `fan${n}_label`)) || `Quạt ${n}`, rpm, pwm: Number.isFinite(pwm) && read(path.join(base, `pwm${n}`)) != null ? Math.round(pwm / 255 * 100) : null });
    }
  }
  if (out.length === 1 && /^Quạt \d+$/.test(out[0].label)) out[0].label = 'Quạt CPU';
  return out;
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

// ---- Mạng: tốc độ tính từ chênh lệch byte trong /proc/net/dev giữa 2 lần đọc ----
const NET_SKIP = /^(lo|docker|veth|br-|virbr|tun|tap|wg)/;
function netCounters() {
  const out = {};
  for (const l of (read('/proc/net/dev', '') || '').split('\n').slice(2)) {
    const m = l.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m || NET_SKIP.test(m[1].trim())) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1].trim()] = { rx: v[0], tx: v[8] };
  }
  return out;
}
let lastNet = { t: Date.now(), c: netCounters() };
let lastRates = {};
function netRates() {
  const now = Date.now();
  const dt = (now - lastNet.t) / 1000;
  if (dt < 1 && Object.keys(lastRates).length) return lastRates; // 2 lần đọc quá sát nhau -> giữ số cũ cho khỏi nhiễu (trừ lần đầu sau khởi động)
  const c = netCounters();
  const r = {};
  for (const [n, v] of Object.entries(c)) {
    const p = lastNet.c[n];
    r[n] = {
      rx: p ? Math.max(0, (v.rx - p.rx) / dt) : 0, tx: p ? Math.max(0, (v.tx - p.tx) / dt) : 0,
      rxTotal: v.rx, txTotal: v.tx,
    };
  }
  lastNet = { t: now, c };
  lastRates = r;
  return r;
}
function network(rates) {
  const addrs = os.networkInterfaces();
  return Object.keys(rates).map(name => {
    const base = path.join('/sys/class/net', name);
    const up = read(path.join(base, 'operstate')) === 'up';
    const speed = Number(read(path.join(base, 'speed')));
    const ip = (addrs[name] || []).find(a => a.family === 'IPv4');
    return {
      name, up, wifi: fs.existsSync(path.join(base, 'wireless')),
      speed: up && speed > 0 ? speed : null, // Mbps; Wi-Fi thường không báo
      mac: read(path.join(base, 'address')), ip: ip ? ip.address : null,
      ...rates[name],
    };
  }).sort((a, b) => b.up - a.up || a.wifi - b.wifi);
}

// ---- Lịch sử 10 phút (lấy mẫu mỗi 10 giây, chạy nền, rất nhẹ) ----
// ---------- Điện năng CPU (Intel RAPL) ----------
// /sys/class/powercap/intel-rapl:0/energy_uj mặc định chỉ root đọc được -> chạy scripts/setup-power.sh (sudo) 1 lần.
// Đo phần CPU (package: nhân + GPU tích hợp + bộ nhớ đệm), chưa gồm ổ cứng / RAM / mainboard / adapter.
const RAPL = '/sys/class/powercap/intel-rapl:0';
const power = { available: false, watts: null, avg: null, wh: 0, since: Date.now(), last: null, maxRange: Number(read(RAPL + '/max_energy_range_uj', 0)) || 0, reason: '' };
// Ước tính cả máy NUC (đo ở ổ cắm) từ điện CPU: (CPU × hao hụt bộ ổn áp + phần còn lại của máy) ÷ hiệu suất adapter.
// Phần còn lại ~2.5 W: RAM DDR3L 8GB ~1 W, SSD SATA ~0.5 W, LAN ~0.5 W, quạt + linh tinh ~0.5 W (BRIX J3160: ~4–5 W rảnh, ~10–11 W tải nặng)
const NUC_BASE_W = Number(process.env.NUC_BASE_W) || 2.5, NUC_VRM = 1.12, NUC_ADAPTER_EFF = 0.87;
const nucWatts = w => (w == null ? null : Math.round((w * NUC_VRM + NUC_BASE_W) / NUC_ADAPTER_EFF * 100) / 100);
function readPower() {
  const e = read(RAPL + '/energy_uj');
  if (e == null) {
    power.available = false;
    power.reason = fs.existsSync(RAPL) ? 'no-permission' : 'unsupported';
    return null;
  }
  const now = Date.now(), uj = Number(e);
  power.available = true; power.reason = '';
  if (power.last) {
    let d = uj - power.last.uj;
    if (d < 0 && power.maxRange) d += power.maxRange; // bộ đếm quay vòng
    const dt = (now - power.last.t) / 1000;
    if (d >= 0 && dt > 0.5) {
      power.watts = Math.round(d / 1e6 / dt * 100) / 100;
      power.wh += d / 3.6e9;
      const hours = (now - power.since) / 3.6e6;
      power.avg = hours > 0 ? Math.round(power.wh / hours * 100) / 100 : power.watts;
    }
  } else power.since = now;
  power.last = { uj, t: now };
  return power.watts;
}

const HISTORY = 60;
const history = [];
function gateway() {
  for (const line of (read('/proc/net/route', '') || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
      const h = f[2]; return { iface: f[0], ip: [6, 4, 2, 0].map(i => parseInt(h.substr(i, 2), 16)).join('.') };
    }
  }
  return null;
}
// ---- Đo tốc độ Internet (chỉ chạy khi bấm nút): độ trễ, tải xuống, tải lên qua speed.cloudflare.com ----
let speedState = { running: false, last: null, error: null };
async function timed(fn) { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
async function runSpeedTest() {
  if (speedState.running) return speedState;
  speedState = { ...speedState, running: true, error: null };
  try {
    const base = 'https://speed.cloudflare.com';
    // Độ trễ: trung vị 5 lần tải 0 byte
    const pings = [];
    for (let i = 0; i < 5; i++) pings.push(await timed(async () => { await (await fetch(`${base}/__down?bytes=0`, { cache: 'no-store' })).arrayBuffer(); }));
    pings.sort((a, b) => a - b);
    // Thông tin IP public / máy chủ gần nhất
    const trace = Object.fromEntries((await (await fetch(`${base}/cdn-cgi/trace`)).text()).trim().split('\n').map(l => l.split('=')));
    // Tải xuống 25MB
    const DOWN = 25e6; let got = 0;
    const downMs = await timed(async () => { const r = await fetch(`${base}/__down?bytes=${DOWN}`, { cache: 'no-store' }); got = (await r.arrayBuffer()).byteLength; });
    // Tải lên 10MB
    const UP = 10e6;
    const upMs = await timed(async () => { await (await fetch(`${base}/__up`, { method: 'POST', body: Buffer.alloc(UP), headers: { 'Content-Type': 'application/octet-stream' } })).text(); });
    speedState.last = {
      at: new Date().toISOString(), ping: Math.round(pings[2]),
      down: +((got * 8) / (downMs / 1000) / 1e6).toFixed(1), up: +((UP * 8) / (upMs / 1000) / 1e6).toFixed(1),
      ip: trace.ip || null, colo: trace.colo || null, loc: trace.loc || null,
    };
  } catch (e) {
    speedState.error = 'Không đo được: ' + (e.cause && e.cause.code ? e.cause.code : e.message);
  } finally { speedState.running = false; }
  return speedState;
}

function sample(record = true) {
  const c = cpuUsage();
  const temps = temperatures();
  const fanList = fans();
  const cpuTemp = Math.max(...temps.filter(t => t.chip === 'coretemp').map(t => t.value), ...(temps.length ? [] : [0]));
  const net = Object.values(netRates());
  const w = record ? readPower() : power.watts;
  if (record) {
    history.push({
      t: Date.now(), cpu: c.total, temp: Number.isFinite(cpuTemp) && cpuTemp > 0 ? cpuTemp : null,
      fan: fanList.length ? Math.max(...fanList.map(f => f.rpm)) : null,
      rx: net.reduce((s, n) => s + n.rx, 0), tx: net.reduce((s, n) => s + n.tx, 0), w, nw: nucWatts(w),
    });
    if (history.length > HISTORY) history.shift();
  }
  return { c, temps, fans: fanList };
}
sample();
setInterval(sample, 10000).unref();

function snapshot() {
  const { c, temps, fans: fanList } = sample(false);
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
    fans: fanList,
    memory: memory(),
    disks: [disk('/')].filter(Boolean),
    network: network(netRates()),
    gateway: gateway(),
    speedTest: speedState,
    app: {
      node: process.version, pid: process.pid, uptime: process.uptime(), rss: process.memoryUsage().rss,
      manager: process.env.pm_id !== undefined ? 'PM2' : 'thủ công', env: config.isProd ? 'production' : 'development',
      db, uploads: dirSize(config.uploadDir), backups,
    },
    power: {
      available: power.available, reason: power.reason, watts: power.watts, avg: power.avg, wh: Math.round(power.wh * 100) / 100, since: new Date(power.since).toISOString(),
      // cả máy NUC (ước tính): điện năng = CPU đã đo + phần còn lại theo thời gian đo
      nuc: power.watts == null ? null : {
        watts: nucWatts(power.watts), avg: nucWatts(power.avg),
        wh: Math.round(((power.wh * NUC_VRM) + NUC_BASE_W * (Date.now() - power.since) / 3.6e6) / NUC_ADAPTER_EFF * 100) / 100,
      },
    },
    requests: require('./reqStats').stats(),
    history,
  };
}

module.exports = { snapshot, runSpeedTest, speedStatus: () => speedState };
