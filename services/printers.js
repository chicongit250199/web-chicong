'use strict';
// Quản lý máy in qua CUPS (cắm USB vào NUC hoặc máy in mạng LAN).
// Gọi các lệnh lpstat / lpadmin / lp / cancel bằng execFile (không qua shell). Quyền quản trị CUPS:
// user chạy web phải thuộc nhóm lpadmin (sudo usermod -aG lpadmin <user>).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

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
  }));

  const jobs = [...o.matchAll(/^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/gm)].map(m => ({ id: `${m[1]}-${m[2]}`, printer: m[1], user: m[3], size: Number(m[4]), time: m[5].trim() }));
  return { available: true, running: true, printers, jobs };
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
  const out = await run('lp', ['-d', name, '-t', 'Trang in thử', f]);
  return (out.match(/request id is (\S+)/) || [])[1] || '';
}

// In file tải lên (PDF, ảnh, văn bản)
const PRINT_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'text/plain': '.txt' };
async function printFile(name, file, { copies = 1, fit = true, title = '' } = {}) {
  checkName(name);
  const ext = PRINT_TYPES[file && file.mimetype];
  if (!ext) throw Object.assign(new Error('Chỉ in được file PDF, JPG, PNG hoặc TXT'), { status: 400 });
  const tmp = path.join(os.tmpdir(), `chicong-print-${crypto.randomBytes(6).toString('hex')}${ext}`);
  await fs.promises.writeFile(tmp, file.buffer);
  try {
    const n = Math.min(99, Math.max(1, parseInt(copies, 10) || 1));
    const args = ['-d', name, '-n', String(n), '-t', String(title || file.originalname || 'file').slice(0, 100)];
    if (fit && ext !== '.txt') args.push('-o', 'fit-to-page');
    args.push(tmp);
    const out = await run('lp', args, { timeout: 60000 });
    return (out.match(/request id is (\S+)/) || [])[1] || '';
  } finally {
    // CUPS đã chép file vào hàng đợi khi lp trả về
    fs.promises.unlink(tmp).catch(() => {});
  }
}

const cancelJob = id => run('cancel', [checkJob(id)]);
const cancelAll = name => run('cancel', ['-a', checkName(name)]);

module.exports = { available, status, discover, models, add, remove, setDefault, setEnabled, testPage, printFile, cancelJob, cancelAll, suggestName, PRINT_TYPES };
