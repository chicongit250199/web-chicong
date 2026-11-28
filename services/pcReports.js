'use strict';
// Báo cáo cấu hình máy do script SysCheck (link /shel) gửi lên.
// Chưa gắn vào task → tự xóa sau 1 ngày (đỡ tốn dung lượng); gắn rồi giữ luôn để lần sau so theo serial.
const db = require('../db');

const KEEP_UNLINKED_MS = 24 * 3600 * 1000;
const MAX_UNLINKED = 300;     // chặn spam: giữ tối đa 300 báo cáo chưa gắn
const MAX_JSON = 256 * 1024;

// Giá trị rác hãng hay để trong BIOS
const JUNK = /^(to be filled.*|default string|system (product name|serial number|manufacturer|version)|o\.?e\.?m\.?|oem|none|n\/?a|not applicable|invalid|unknown|0+|1234567890?|123456789|x+|\.+|-+)$/i;
const clean = (s, max = 200) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  return t && !JUNK.test(t) ? t : '';
};
const num = (x) => (x == null || x === '' || isNaN(Number(x)) ? null : Number(x));
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? [x] : []); // PowerShell gửi mảng 1 phần tử thành object
const gb = (x) => { const n = num(x); return n == null ? '' : (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + ' GB'; };
const vnNum = (n) => Number(n).toLocaleString('vi-VN');
// Bỏ (R), (TM), chữ "CPU" thừa trong tên linh kiện
const pretty = (s) => clean(s).replace(/\((R|TM|C)\)/gi, '').replace(/\s+CPU\s+@/i, ' @').replace(/\s+/g, ' ').trim();

function normMaker(m) {
  const t = clean(m, 80);
  if (/hewlett|^hp\b/i.test(t)) return 'HP';
  if (/^dell/i.test(t)) return 'Dell';
  if (/^lenovo/i.test(t)) return 'Lenovo';
  if (/^asus/i.test(t)) return 'ASUS';
  if (/^acer/i.test(t)) return 'Acer';
  if (/micro-star|^msi/i.test(t)) return 'MSI';
  if (/gigabyte/i.test(t)) return 'Gigabyte';
  if (/^microsoft/i.test(t)) return 'Microsoft';
  return t;
}

// Tên máy dễ đọc: Lenovo dùng Version (VD "ThinkPad T480"), máy ráp dùng hãng + mã mainboard
function deviceName(d) {
  const maker = normMaker(d.maker);
  let model = clean(d.model);
  const ver = clean(d.productVersion);
  if (maker === 'Lenovo' && ver && !/^lenovo$/i.test(ver)) model = ver.replace(/^lenovo\s+/i, '');
  if (!maker && !model) {
    const bm = clean(d.boardMaker);
    let prod = clean(d.board);
    if (bm && prod.toLowerCase().startsWith(bm.toLowerCase())) prod = prod.slice(bm.length).trim();
    const b = [normMaker(bm), prod].filter(Boolean).join(' ');
    return b ? 'PC ' + b : '';
  }
  if (model && maker && model.toLowerCase().startsWith(maker.toLowerCase())) return model;
  return [maker, model].filter(Boolean).join(' ');
}

function summarize(d) {
  const L = [];
  const cpu = d.cpu || {};
  if (cpu.name) L.push(`CPU: ${pretty(cpu.name)}${cpu.cores ? ` (${cpu.cores} nhân / ${cpu.threads || '?'} luồng)` : ''}`);
  const ram = d.ram || {};
  const mods = arr(ram.modules);
  if (ram.totalGB) {
    const types = [...new Set(mods.map(m => m.type).filter(Boolean))].join('/');
    const mhz = Math.max(0, ...mods.map(m => num(m.mhz) || 0));
    const sizes = mods.map(m => Math.round(num(m.gb) || 0)).filter(Boolean);
    L.push(`RAM: ${gb(ram.totalGB)}${types ? ' ' + types : ''}${mhz ? ' ' + mhz + 'MHz' : ''}`
      + (ram.slots ? ` (${mods.length}/${ram.slots} khe${sizes.length > 1 ? ': ' + sizes.join('+') + ' GB' : ''})` : ''));
  }
  const disks = arr(d.disks).map(k => {
    const bits = [k.media && k.media !== 'Unspecified' ? k.media : '', k.bus].filter(Boolean).join(' ');
    const extra = [bits, k.healthPct != null ? 'còn ' + k.healthPct + '%' : '', k.hours ? vnNum(k.hours) + ' giờ' : ''].filter(Boolean).join(', ');
    return `${clean(k.name) || 'Ổ đĩa'} ${gb(k.sizeGB)}${extra ? ' (' + extra + ')' : ''}`;
  });
  if (disks.length) L.push('Ổ cứng: ' + disks.join(' · '));
  // VGA onboard Intel dùng chung RAM → không ghi VRAM
  const gpus = arr(d.gpus).map(g => `${pretty(g.name)}${num(g.vramGB) >= 0.5 && !/intel/i.test(g.name) ? ' ' + gb(g.vramGB) : ''}`).filter(s => s.trim());
  if (gpus.length) L.push('VGA: ' + gpus.join(' · '));
  const b = d.battery;
  if (b && (b.healthPct != null || b.model || b.cycles)) {
    const bits = [];
    if (b.healthPct != null) bits.push(`chai ${Math.round(b.wearPct)}% (còn ${Math.round(b.healthPct)}%, ${vnNum(b.fullCap)}/${vnNum(b.designCap)} mWh)`);
    if (num(b.cycles) > 0) bits.push(`${vnNum(b.cycles)} lần sạc`);
    const model = [clean(b.model, 80), clean(b.maker, 40)].filter(Boolean).join(' - ');
    if (model) bits.push(model);
    L.push('Pin: ' + bits.join(' · '));
  }
  if (d.os) L.push(`Windows: ${clean(d.os).replace(/^Microsoft\s+/i, '')}${d.license ? ' — ' + clean(d.license) : ''}`);
  const sn = clean(d.serial);
  if (sn) L.push('S/N: ' + sn);
  return L.join('\n');
}

const q = {
  insert: db.prepare(`INSERT INTO pc_reports (serial, maker, model, computer_name, summary, data, ip) VALUES (@serial, @maker, @model, @computer_name, @summary, @data, @ip)`),
  cleanupOld: db.prepare(`DELETE FROM pc_reports WHERE task_id IS NULL AND created_at < ?`),
  cleanupMany: db.prepare(`DELETE FROM pc_reports WHERE task_id IS NULL AND id NOT IN (SELECT id FROM pc_reports WHERE task_id IS NULL ORDER BY id DESC LIMIT ${MAX_UNLINKED})`),
  recent: db.prepare(`SELECT r.id, r.serial, r.maker, r.model, r.computer_name, r.summary, r.ip, r.created_at, r.task_id, t.ticket_code
                      FROM pc_reports r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.created_at >= ? ORDER BY r.id DESC LIMIT 50`),
  get: db.prepare('SELECT * FROM pc_reports WHERE id = ?'),
  link: db.prepare('UPDATE pc_reports SET task_id = ?, linked_at = ? WHERE id = ?'),
  byTask: db.prepare('SELECT * FROM pc_reports WHERE task_id = ? ORDER BY id DESC'),
  bySerial: db.prepare(`SELECT r.id, r.summary, r.created_at, r.task_id, t.ticket_code FROM pc_reports r JOIN tasks t ON t.id = r.task_id
                        WHERE r.serial = ? AND r.task_id <> ? ORDER BY r.id DESC LIMIT 10`),
};

function cleanup() {
  q.cleanupOld.run(new Date(Date.now() - KEEP_UNLINKED_MS).toISOString());
  q.cleanupMany.run();
}

function add(body, ip) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Dữ liệu không hợp lệ');
  const json = JSON.stringify(body);
  if (json.length > MAX_JSON) throw new Error('Dữ liệu quá lớn');
  const summary = summarize(body);
  if (!summary) throw new Error('Báo cáo trống');
  cleanup();
  const row = {
    serial: clean(body.serial, 80) || null, maker: normMaker(body.maker) || null, model: deviceName(body) || null,
    computer_name: clean(body.computerName, 80) || null, summary, data: json, ip: String(ip || '').replace(/^::ffff:/, '').slice(0, 45),
  };
  const id = q.insert.run(row).lastInsertRowid;
  return { id, model: row.model, summary };
}

// Báo cáo 24 giờ gần đây (để chọn khi nhận máy)
const recent = () => { cleanup(); return q.recent.all(new Date(Date.now() - KEEP_UNLINKED_MS).toISOString()); };

function link(id, taskId) {
  const r = q.get.get(id);
  if (!r) throw new Error('Báo cáo không còn (chưa gắn vào máy nào thì chỉ giữ 1 ngày)');
  q.link.run(taskId, new Date().toISOString(), id);
  return r;
}

// Báo cáo đã gắn vào task + các lần kiểm tra trước của cùng máy (theo serial)
function forTask(taskId) {
  return q.byTask.all(taskId).map(r => {
    let d = {};
    try { d = JSON.parse(r.data); } catch { /* bỏ qua */ }
    return { ...r, d, history: r.serial ? q.bySerial.all(r.serial, taskId) : [] };
  });
}

setInterval(() => { try { cleanup(); } catch { /* bỏ qua */ } }, 3600 * 1000).unref();

module.exports = { add, recent, link, forTask, cleanup, summarize, deviceName, arr };
