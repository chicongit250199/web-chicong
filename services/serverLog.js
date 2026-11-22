'use strict';
// Đọc console của máy chủ từ file log PM2 (logs/out-0.log, logs/error-0.log, kèm bản đã xoay vòng .gz)
// Dòng PM2 (time: true) có dạng "2026-11-21T16:35:14: nội dung" — giờ UTC.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'logs');
const TAIL_BYTES = 512 * 1024; // chỉ đọc phần cuối file
const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d): ?(.*)$/;

function listFiles() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return { out: {}, err: {} }; }
  const pick = (kind) => {
    const cur = names.find((n) => new RegExp(`^${kind}(-\\d+)?\\.log$`).test(n));
    const rotated = names.filter((n) => new RegExp(`^${kind}(-\\d+)?__.*\\.log(\\.gz)?$`).test(n)).sort(); // tên có ngày giờ → sắp xếp theo chữ là theo thời gian
    return { cur: cur && path.join(DIR, cur), prev: rotated.length ? path.join(DIR, rotated[rotated.length - 1]) : null };
  };
  return { out: pick('out'), err: pick('error') };
}

function readTail(file) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let s = buf.toString('utf8');
    if (start > 0) s = s.slice(s.indexOf('\n') + 1); // bỏ dòng cắt dở
    return s;
  } catch { return ''; }
}

function readRotated(file) {
  try {
    const raw = fs.readFileSync(file);
    const s = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
    return s.length > TAIL_BYTES ? s.slice(s.indexOf('\n', s.length - TAIL_BYTES) + 1) : s;
  } catch { return ''; }
}

function parse(text, stream) {
  const rows = [];
  let ts = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = TS_RE.exec(line);
    if (m) { ts = m[1]; rows.push({ t: ts, s: stream, m: m[2] }); }
    else rows.push({ t: ts, s: stream, m: line }); // dòng tiếp theo của stack trace / JSON nhiều dòng
  }
  return rows;
}

function streamLines(f, limit) {
  if (!f.cur && !f.prev) return [];
  let rows = f.cur ? parse(readTail(f.cur), null) : [];
  if (rows.length < limit && f.prev) rows = parse(readRotated(f.prev), null).concat(rows); // file hiện tại vừa xoay vòng → lấy thêm bản trước
  return rows.slice(-limit);
}

// Dấu hiệu thay đổi: kích thước + thời điểm sửa của 2 file hiện tại
function signature() {
  const f = listFiles();
  return [f.out.cur, f.err.cur, f.out.prev, f.err.prev].map((p) => {
    if (!p) return '-';
    try { const st = fs.statSync(p); return `${path.basename(p)}:${st.size}:${st.mtimeMs}`; } catch { return '-'; }
  }).join('|');
}

function tail(limit = 300) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 300, 20), 2000);
  const f = listFiles();
  const out = streamLines(f.out, limit).map((r) => ({ ...r, s: 'out' }));
  const err = streamLines(f.err, limit).map((r) => ({ ...r, s: 'err' }));
  // gộp 2 luồng theo thời gian (giữ thứ tự gốc khi cùng giây)
  const all = [];
  let i = 0, j = 0;
  while (i < out.length || j < err.length) {
    if (j >= err.length || (i < out.length && (out[i].t || '') <= (err[j].t || ''))) all.push(out[i++]);
    else all.push(err[j++]);
  }
  return { sig: signature(), lines: all.slice(-limit), file: f.out.cur ? path.relative(path.join(DIR, '..'), f.out.cur) : null };
}

module.exports = { tail, signature };
