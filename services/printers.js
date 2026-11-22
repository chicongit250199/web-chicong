'use strict';
// Quản lý máy in qua CUPS (cắm USB vào NUC hoặc máy in mạng LAN).
// Gọi các lệnh lpstat / lpadmin / lp / cancel bằng execFile (không qua shell). Quyền quản trị CUPS:
// user chạy web phải thuộc nhóm lpadmin (sudo usermod -aG lpadmin <user>).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const ENV = { ...process.env, LANG: 'C', LC_ALL: 'C' };
function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').trim() || (err.killed ? 'Quá thời gian chờ' : err.message);
        const e = new Error(msg.replace(/^\w+: /, ''));
        e.code = err.code;
        return reject(e);
      }
      resolve(String(stdout));
    });
  });
}
const has = bin => ['/usr/bin', '/usr/sbin', '/bin'].some(d => fs.existsSync(path.join(d, bin)));

function available() { return has('lpstat') && has('lpadmin'); }

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const URI_RE = /^(ipp|ipps|http|https|socket|lpd|usb|dnssd|ippusb|smb|implicitclass):\/\/\S{1,500}$/;
function checkName(n) { if (!NAME_RE.test(n || '')) throw Object.assign(new Error('Tên máy in chỉ gồm chữ không dấu, số, - _ .'), { status: 400 }); return n; }
function checkJob(id) { if (!/^[A-Za-z0-9_.-]{1,64}-\d+$/.test(id || '')) throw Object.assign(new Error('Mã lệnh in không hợp lệ'), { status: 400 }); return id; }

// Giờ trong lpstat (theo múi giờ server) -> giờ VN dễ đọc
function vnTime(s) {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  const d = new Date(t + 7 * 3600e3).toISOString(); // giờ VN
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

// Tên gợi ý từ tên model: "HP LaserJet Pro M404" -> "HP_LaserJet_Pro_M404"
const suggestName = s => String(s || 'MayIn').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'MayIn';

async function status() {
  if (!available()) return { available: false, printers: [], jobs: [] };
  let cupsRunning = true;
  const [p, d, v, a, o] = await Promise.all([
    run('lpstat', ['-p']).catch(e => { if (/scheduler/i.test(e.message)) cupsRunning = false; return ''; }),
    run('lpstat', ['-d']).catch(() => ''),
    run('lpstat', ['-v']).catch(() => ''),
    run('lpstat', ['-a']).catch(() => ''),
    run('lpstat', ['-o']).catch(() => ''),
  ]);
  if (!cupsRunning) return { available: true, running: false, printers: [], jobs: [] };
  const def = (d.match(/system default destination: (\S+)/) || [])[1] || null;
  const uris = Object.fromEntries([...v.matchAll(/^device for (\S+): (\S+)/gm)].map(m => [m[1], m[2]]));
  const accepting = Object.fromEntries([...a.matchAll(/^(\S+) (not )?accepting/gm)].map(m => [m[1], !m[2]]));

  const printers = [];
  const lines = p.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^printer (\S+) (?:is (idle|printing)|(disabled))/);
    if (!m) continue;
    let reason = '';
    while (lines[i + 1] && /^\s/.test(lines[i + 1])) { reason += lines[++i].trim() + ' '; }
    printers.push({
      name: m[1], state: m[3] ? 'disabled' : m[2], reason: reason.trim(), isDefault: m[1] === def,
      uri: uris[m[1]] || '', accepting: accepting[m[1]] !== false,
    });
  }
  // Thông tin mô tả (model, vị trí) từng máy
  await Promise.all(printers.map(async pr => {
    const out = await run('lpoptions', ['-p', pr.name]).catch(() => '');
    const get = k => { const mm = out.match(new RegExp(`(?:^| )${k}=('([^']*)'|(\\S*))`)); return mm ? (mm[2] ?? mm[3] ?? '').replace(/\\(.)/g, '$1') : ''; };
    pr.info = get('printer-info');
    pr.model = get('printer-make-and-model');
    pr.location = get('printer-location');
    pr.reasons = get('printer-state-reasons');
    pr.connection = /^usb:|^ippusb:/.test(pr.uri) ? 'USB' : pr.uri ? 'Mạng' : '';
    pr.shared = get('printer-is-shared') === 'true';
    // Khổ giấy mặc định + các khổ driver hỗ trợ (dấu * = đang chọn)
    const l = await run('lpoptions', ['-p', pr.name, '-l']).catch(() => '');
    const ps = l.match(/^PageSize\/[^:]*:\s*(.+)$/m);
    pr.pageSizes = ps ? ps[1].trim().split(/\s+/).map(x => x.replace(/^\*/, '')) : [];
    pr.pageSize = ps ? ((ps[1].match(/\*(\S+)/) || [])[1] || '') : '';
  }));

  const jobs = [...o.matchAll(/^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/gm)].map(m => ({ id: `${m[1]}-${m[2]}`, printer: m[1], user: m[3], size: Number(m[4]), time: vnTime(m[5].trim()) }));
  // Tên tài liệu (lpstat -o không có) -> lấy từ lpq của từng máy đang có lệnh in
  const titles = {};
  await Promise.all([...new Set(jobs.map(j => j.printer))].map(async name => {
    const q = await run('lpq', ['-P', name]).catch(() => '');
    for (const m of q.matchAll(/^\S+\s+\S+\s+(\d+)\s+(.+?)\s+\d+ bytes\s*$/gm)) titles[`${name}-${m[1]}`] = m[2].trim();
  }));
  for (const j of jobs) j.title = titles[j.id] || '';
  return { available: true, running: true, printers, jobs, sharing: await serverSharing(), host: os.hostname() };
}

// Tìm máy in: cắm USB + mạng LAN (Bonjour / IPP). Cần quyền lpadmin.
async function discover() {
  const out = await run('lpinfo', ['--timeout', '10', '-v'], { timeout: 30000 });
  const seen = new Set();
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+:\/\/\S+)/);
    if (!m) continue;
    const uri = m[2];
    if (seen.has(uri)) continue;
    seen.add(uri);
    let label = decodeURIComponent(uri.replace(/^\w+:\/\//, '').split(/[?/]/)[0]).replace(/\+/g, ' ');
    label = label.replace(/\._[a-z-]+\._tcp\.local\.?$/i, '').replace(/\s*\[[0-9A-F]+\]$/i, '').replace(/:\d+$/, '');
    if (uri.startsWith('usb:')) label = decodeURIComponent(uri.slice(6).split('?')[0]).replace(/\//g, ' ').replace(/\+/g, ' ');
    found.push({ uri, kind: m[1], connection: /^(usb|ippusb):/.test(uri) ? 'USB' : 'Mạng', label: label.trim(), suggested: suggestName(label) });
  }
  // dnssd (tự tìm qua Bonjour) lên đầu, rồi USB
  const rank = f => (f.uri.startsWith('dnssd:') ? 0 : f.connection === 'USB' ? 1 : 2);
  return found.sort((x, y) => rank(x) - rank(y));
}

// Danh sách driver đã cài (lpinfo -m) — cache vì chạy chậm
let modelCache = null;
async function models(q) {
  if (!modelCache) {
    const out = await run('lpinfo', ['-m'], { timeout: 60000 });
    modelCache = out.split('\n').map(l => { const i = l.indexOf(' '); return i > 0 ? { id: l.slice(0, i), name: l.slice(i + 1).trim() } : null; })
      .filter(x => x && x.id !== 'everywhere' && x.id !== 'raw');
  }
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return modelCache.filter(m => words.every(w => m.name.toLowerCase().includes(w))).slice(0, 50);
}

// Thêm máy in. driver: 'everywhere' (không cần driver, máy in đời mới), 'raw' (máy in bill/tem nhiệt), hoặc id driver từ models()
async function add({ name, uri, driver, info, location, makeDefault }) {
  checkName(name);
  if (!URI_RE.test(uri || '')) throw Object.assign(new Error('Địa chỉ máy in không hợp lệ (vd: ipp://192.168.1.50/ipp/print hoặc socket://192.168.1.50:9100)'), { status: 400 });
  const drv = driver || 'everywhere';
  if (!/^[\w.:/+=@-]{1,300}$/.test(drv) || drv.startsWith('-')) throw Object.assign(new Error('Driver không hợp lệ'), { status: 400 });
  const args = ['-p', name, '-E', '-v', uri, '-m', drv];
  if (info) args.push('-D', String(info).slice(0, 120));
  if (location) args.push('-L', String(location).slice(0, 120));
  try {
    await run('lpadmin', args, { timeout: 60000 });
  } catch (e) {
    if (drv === 'everywhere') e.message += ' — máy in này có thể không hỗ trợ in không cần driver; thử chọn driver theo model hoặc "Raw".';
    throw e;
  }
  if (makeDefault) await run('lpadmin', ['-d', name]);
  return name;
}

const remove = name => run('lpadmin', ['-x', checkName(name)]);
const setDefault = name => run('lpadmin', ['-d', checkName(name)]);
async function setEnabled(name, on) {
  checkName(name);
  if (on) { await run('cupsenable', [name]); await run('cupsaccept', [name]); } else { await run('cupsdisable', [name]); await run('cupsreject', [name]); }
}
async function testPage(name) {
  checkName(name);
  const f = ['/usr/share/cups/data/testprint', '/usr/share/cups/data/default-testpage.pdf'].find(x => fs.existsSync(x));
  if (!f) throw new Error('Không tìm thấy trang in thử của CUPS');
  await ensureOnline(name);
  const out = await run('lp', ['-d', name, '-t', 'Trang in thử', f]);
  return (out.match(/request id is (\S+)/) || [])[1] || '';
}

// ---------- Kiểm tra máy in còn bật trước khi gửi lệnh in ----------
// CUPS không tự dò máy in: máy tắt vẫn báo "idle", lệnh in nằm chờ trong hàng đợi. Nên trước mỗi lần in kiểm tra nhanh:
//  - usb://  : thiết bị có trên cổng USB của NUC không (đọc /sys, so serial / tên model)
//  - socket/ipp/http/lpd://  : mở kết nối TCP tới máy in (2 giây)
//  - loại khác (dnssd...) : không kiểm tra được -> cho in
const usbDevices = () => {
  const base = '/sys/bus/usb/devices';
  let names = [];
  try { names = fs.readdirSync(base); } catch { return null; }
  const rd = (d, f) => { try { return fs.readFileSync(path.join(base, d, f), 'utf8').trim(); } catch { return ''; } };
  return names.map(d => ({ product: rd(d, 'product'), serial: rd(d, 'serial'), maker: rd(d, 'manufacturer') })).filter(x => x.product);
};
function tcpOpen(host, port, ms = 2000) {
  return new Promise(resolve => {
    const sock = require('net').connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function deviceOnline(uri) {
  let u;
  try { u = new URL(uri); } catch { return true; }
  const scheme = u.protocol.replace(':', '');
  if (scheme === 'usb') {
    const devs = usbDevices();
    if (!devs) return true; // không đọc được /sys -> bỏ qua kiểm tra
    const serial = u.searchParams.get('serial');
    const model = decodeURIComponent(u.pathname.replace(/^\//, '')).toLowerCase();
    return devs.some(d => (serial ? d.serial === serial : false) || (model && d.product.toLowerCase().includes(model)));
  }
  const port = Number(u.port) || { socket: 9100, ipp: 631, ipps: 631, http: 80, https: 443, lpd: 515 }[scheme];
  if (!port || !u.hostname) return true;
  return tcpOpen(u.hostname, port);
}
async function ensureOnline(name) {
  checkName(name);
  const p = await run('lpstat', ['-p', name]).catch(() => '');
  if (!p.trim()) throw Object.assign(new Error(`Không tìm thấy máy in "${name}".`), { status: 400 });
  if (/disabled/.test(p)) throw Object.assign(new Error(`Máy in ${name} đang tạm dừng — báo quản lý bật lại ở trang Hệ thống.`), { status: 409 });
  const v = await run('lpstat', ['-v', name]).catch(() => '');
  const uri = (v.match(/:\s*(\S+:\/\/\S+)/) || [])[1];
  if (uri && !(await deviceOnline(uri))) {
    const usb = uri.startsWith('usb:');
    throw Object.assign(new Error(`Máy in ${name} đang tắt hoặc mất kết nối${usb ? ' (không thấy trên cổng USB của máy chủ)' : ' (không kết nối được qua mạng)'}. Bật máy in / kiểm tra dây cáp rồi in lại — lệnh in chưa được gửi.`), { status: 409, offline: true });
  }
}

// In file tải lên (PDF, ảnh, văn bản): file nằm trong RAM -> đẩy thẳng vào lp qua stdin,
// KHÔNG ghi ra ổ cứng server. CUPS cấu hình PreserveJobFiles=No nên in xong cũng xóa bản trong hàng đợi.
const PRINT_TYPES = { 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG', 'text/plain': 'TXT' };
const PRINT_EXT = /\.(pdf|jpe?g|png|txt)$/i;
function typeOf(file) {
  if (!file) return null;
  if (PRINT_TYPES[file.mimetype]) return file.mimetype;
  // một số trình duyệt gửi application/octet-stream -> đoán theo đuôi
  const m = String(file.originalname || '').match(PRINT_EXT);
  return m ? { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', txt: 'text/plain' }[m[1].toLowerCase()] : null;
}
function lpStdin(args, buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn('lp', args, { env: ENV });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim() || `lp lỗi (mã ${code})`).replace(/^\w+: /, '')));
    });
    child.stdin.on('error', () => {}); // lp thoát sớm -> lỗi đã có ở stderr
    child.stdin.end(buffer);
  });
}
async function printFile(name, file, { copies = 1, fit = true, title = '', duplex = false } = {}) {
  checkName(name);
  const type = typeOf(file);
  if (!type) throw Object.assign(new Error('Chỉ in được file PDF, JPG, PNG hoặc TXT'), { status: 400 });
  await ensureOnline(name);
  const n = Math.min(99, Math.max(1, parseInt(copies, 10) || 1));
  const args = ['-d', name, '-n', String(n), '-t', String(title || file.originalname || 'file').slice(0, 100)];
  if (fit && type !== 'text/plain') args.push('-o', 'fit-to-page');
  if (duplex) args.push('-o', 'sides=two-sided-long-edge');
  args.push('-'); // đọc từ stdin
  const out = await lpStdin(args, file.buffer);
  return (out.match(/request id is (\S+)/) || [])[1] || '';
}

// Chia sẻ máy in trong mạng LAN (Mac / Windows / điện thoại in thẳng, không qua web)
async function serverSharing() {
  const out = await run('cupsctl', []).catch(() => '');
  return /_share_printers=1/.test(out);
}
const setShared = (name, on) => run('lpadmin', ['-p', checkName(name), '-o', `printer-is-shared=${on ? 'true' : 'false'}`]);

async function setPageSize(name, size) {
  checkName(name);
  if (!/^[\w.-]{1,40}$/.test(size || '')) throw Object.assign(new Error('Khổ giấy không hợp lệ'), { status: 400 });
  const l = await run('lpoptions', ['-p', name, '-l']);
  const ps = (l.match(/^PageSize\/[^:]*:\s*(.+)$/m) || [])[1] || '';
  if (!ps.split(/\s+/).map(x => x.replace(/^\*/, '')).includes(size)) throw Object.assign(new Error('Máy in không hỗ trợ khổ ' + size), { status: 400 });
  await run('lpadmin', ['-p', name, '-o', `PageSize=${size}`]);
}

const cancelJob = id => run('cancel', [checkJob(id)]);
const cancelAll = name => run('cancel', ['-a', checkName(name)]);

module.exports = { ensureOnline, setPageSize, serverSharing, setShared, typeOf, available, status, discover, models, add, remove, setDefault, setEnabled, testPage, printFile, cancelJob, cancelAll, suggestName, PRINT_TYPES };
