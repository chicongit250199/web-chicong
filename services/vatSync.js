'use strict';
// Quét thư mục Drive -> đọc hóa đơn (XML trước, PDF/ảnh qua Gemini) -> lưu vat_invoices + vat_items
const path = require('path');
const db = require('../db');
const config = require('../config');
const drive = require('./driveService');
const { parseInvoiceXml } = require('./vatXml');
const aiService = require('./aiService');
const { stripVi } = require('./inventory');

const MAX_ATTEMPTS = 3; // file lỗi thử lại tối đa 3 lần rồi bỏ qua (bấm "Thử lại file lỗi" để đọc lại)


const q = {
  // Bỏ qua: file đã đọc xong / đã ghép, và file lỗi đã thử đủ MAX_ATTEMPTS lần
  known: db.prepare('SELECT drive_file_id FROM vat_drive_files WHERE status <> ? OR attempts >= ?'),
  markFile: db.prepare(`INSERT INTO vat_drive_files (drive_file_id, direction, file_name, mime_type, invoice_id, status, error)
    VALUES (@id, @direction, @name, @mime, @invoice_id, @status, @error)
    ON CONFLICT(drive_file_id) DO UPDATE SET invoice_id = excluded.invoice_id, status = excluded.status, error = excluded.error,
      attempts = CASE WHEN excluded.status = 'error' THEN attempts + 1 ELSE attempts END, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
  findDup: db.prepare(`SELECT id FROM vat_invoices WHERE direction = ? AND invoice_number = ? AND COALESCE(invoice_symbol,'') = ? AND COALESCE(partner_tax_id,'') = ?`),
  insInvoice: db.prepare(`INSERT INTO vat_invoices (direction, drive_file_id, file_name, drive_link, pdf_link, source_format, invoice_symbol, invoice_number,
      invoice_date, partner_name, partner_tax_id, seller_name, seller_tax_id, buyer_name, buyer_tax_id, subtotal, vat_amount, total_amount, raw_json)
    VALUES (@direction, @drive_file_id, @file_name, @drive_link, @pdf_link, @source_format, @invoice_symbol, @invoice_number,
      @invoice_date, @partner_name, @partner_tax_id, @seller_name, @seller_tax_id, @buyer_name, @buyer_tax_id, @subtotal, @vat_amount, @total_amount, @raw_json)`),
  setPdf: db.prepare('UPDATE vat_invoices SET pdf_link = COALESCE(pdf_link, ?) WHERE id = ?'),
  insItem: db.prepare(`INSERT INTO vat_items (invoice_id, item_name, unit, quantity_in, quantity_remaining, unit_price, total_price, status, vat_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

function kind(f) {
  const ext = path.extname(f.name || '').toLowerCase();
  if (ext === '.xml' || f.mimeType === 'text/xml' || f.mimeType === 'application/xml') return 'xml';
  if (ext === '.pdf' || f.mimeType === 'application/pdf') return 'pdf';
  if (/^image\//.test(f.mimeType)) return 'image';
  return null;
}
const baseName = n => path.basename(n || '', path.extname(n || '')).toLowerCase();

const saveInvoice = db.transaction((direction, file, fmt, data, pdfFile) => {
  const partnerName = direction === 'in' ? data.seller_name : data.buyer_name;
  const partnerTax = direction === 'in' ? data.seller_tax_id : data.buyer_tax_id;
  const dup = data.invoice_number && q.findDup.get(direction, String(data.invoice_number), data.invoice_symbol || '', partnerTax || '');
  if (dup) {
    if (pdfFile) q.setPdf.run(pdfFile.webViewLink, dup.id);
    return { id: dup.id, duplicate: true };
  }
  const { lastInsertRowid: id } = q.insInvoice.run({
    direction, drive_file_id: file.id, file_name: file.name, drive_link: file.webViewLink,
    pdf_link: pdfFile ? pdfFile.webViewLink : (fmt !== 'xml' ? file.webViewLink : null),
    source_format: fmt, invoice_symbol: data.invoice_symbol || null, invoice_number: data.invoice_number ? String(data.invoice_number) : null,
    invoice_date: data.invoice_date || null, partner_name: partnerName || null, partner_tax_id: partnerTax || null,
    seller_name: data.seller_name || null, seller_tax_id: data.seller_tax_id || null,
    buyer_name: data.buyer_name || null, buyer_tax_id: data.buyer_tax_id || null,
    subtotal: data.subtotal ?? null, vat_amount: data.vat_amount ?? null,
    total_amount: data.total_amount ?? null, raw_json: JSON.stringify(data),
  });
  for (const it of data.items || []) {
    const qty = Number(it.quantity) || 0;
    // Hóa đơn đầu vào: tạo tồn kho VAT; hóa đơn bán ra chỉ lưu chi tiết
    q.insItem.run(id, String(it.name).slice(0, 500), it.unit || null, qty, direction === 'in' ? qty : 0,
      it.unit_price != null ? Math.round(it.unit_price) : null, it.amount != null ? Math.round(it.amount) : null,
      direction === 'in' && qty > 0 ? 'available' : 'depleted', it.vat_rate || null);
  }
  return { id, duplicate: false };
});

async function sync(direction, { limit = Infinity, onProgress = () => {} } = {}) {
  const folder = direction === 'in' ? config.driveVatInputFolderId : config.driveVatOutputFolderId;
  if (!folder) {
    const e = new Error(`Chưa cấu hình ${direction === 'in' ? 'DRIVE_VAT_INPUT_FOLDER_ID' : 'DRIVE_VAT_OUTPUT_FOLDER_ID'} trong .env`);
    e.status = 400; e.expose = true; throw e;
  }
  // Không quét thư mục con thuộc chiều ngược lại (VD "HĐ Bán ra" nằm trong thư mục Đầu vào)
  const other = direction === 'in' ? /ban\s*ra|xuat/ : /dau\s*vao|mua\s*vao|nhap/;
  const files = (await drive.listFiles(folder, 1, name => other.test(stripVi(name).toLowerCase()))).filter(kind);
  const known = new Set(q.known.all('error', MAX_ATTEMPTS).map(r => r.drive_file_id));
  const fresh = files.filter(f => !known.has(f.id));

  // Ghép XML + PDF cùng tên: đọc XML (chính xác), PDF chỉ để gắn link xem
  const groups = new Map();
  for (const f of fresh) {
    const k = baseName(f.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const result = { found: fresh.length, total: Math.min(groups.size, limit), processed: 0, added: 0, duplicates: 0, errors: [], remaining: 0, usedAi: 0, current: '' };
  onProgress(result);
  let processed = 0;
  for (const group of groups.values()) {
    if (processed >= limit) { result.remaining += group.length; continue; }
    const xml = group.find(f => kind(f) === 'xml');
    const pdf = group.find(f => kind(f) === 'pdf');
    const main = xml || pdf || group[0];
    const others = group.filter(f => f !== main);
    processed++;
    result.current = main.name;
    onProgress(result);
    try {
      const buf = await drive.download(main.id);
      let data = null;
      let fmt = kind(main);
      if (fmt === 'xml') {
        data = parseInvoiceXml(buf);
        if (!data) { data = await aiService.extractInvoice(buf, 'text/xml'); result.usedAi++; } // XML không theo chuẩn TCT
      } else {
        data = await aiService.extractInvoice(buf, main.mimeType || 'application/pdf');
        result.usedAi++;
      }
      if (!data || !data.invoice_number) throw new Error('Không đọc được số hóa đơn');
      const r = saveInvoice(direction, main, fmt, data, xml && pdf ? pdf : null);
      r.duplicate ? result.duplicates++ : result.added++;
      q.markFile.run({ id: main.id, direction, name: main.name, mime: main.mimeType, invoice_id: r.id, status: 'ok', error: null });
      for (const o of others) q.markFile.run({ id: o.id, direction, name: o.name, mime: o.mimeType, invoice_id: r.id, status: 'skipped', error: null });
    } catch (err) {
      result.errors.push(`${main.name}: ${err.message}`);
      q.markFile.run({ id: main.id, direction, name: main.name, mime: main.mimeType, invoice_id: null, status: 'error', error: String(err.message).slice(0, 500) });
      // Lỗi cấu hình (thiếu API key...): dừng sớm, không lặp lỗi cho mọi file
      if (err.expose) break;
    } finally {
      result.processed = processed;
      onProgress(result);
    }
  }
  result.current = '';
  return result;
}

// ---- Chạy nền: bấm "Cập nhật" trả về ngay, trang hỏi tiến độ định kỳ ----
let job = null;
let auto = { enabled: false, minutes: 0, lastRunAt: null, nextRunAt: null };

function status() { return { job, auto }; }

function start(direction, actor) {
  if (job && job.running) return { job, started: false, promise: Promise.resolve(job) };
  job = { direction, running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, actor: actor || null,
    found: 0, total: 0, processed: 0, added: 0, duplicates: 0, errors: [], usedAi: 0, current: 'Đang đọc danh sách file trên Drive...' };
  const promise = sync(direction, { onProgress: r => Object.assign(job, r) })
    .then(r => {
      Object.assign(job, r, { running: false, finishedAt: new Date().toISOString() });
      // Chỉ thông báo khi có hóa đơn mới hoặc lỗi (tự động quét mỗi giờ sẽ không làm ồn)
      if (r.added || r.errors.length) {
        require('./events').notify('inventory', `Quét hóa đơn ${direction === 'in' ? 'đầu vào' : 'bán ra'}: thêm ${r.added} hóa đơn${r.errors.length ? `, ${r.errors.length} file lỗi` : ''}`,
          `/manager/vat?tab=${direction}`, actor || 'Tự động');
      }
      return job;
    })
    .catch(e => {
      console.error('[vat] sync', e.expose ? e.message : e);
      const msg = e.expose ? e.message
        : /not found|404/i.test(e.message) ? 'Không tìm thấy thư mục Drive — kiểm tra ID và đã share thư mục cho email Service Account chưa.'
          : /permission|403|insufficient/i.test(e.message) ? 'Service Account chưa có quyền đọc thư mục này.'
            : `Lỗi: ${e.message}`;
      Object.assign(job, { running: false, finishedAt: new Date().toISOString(), error: msg, current: '' });
      return job;
    });
  return { job, started: true, promise };
}

// Cho phép đọc lại các file đã lỗi quá số lần thử
function resetErrors() {
  return db.prepare(`DELETE FROM vat_drive_files WHERE status = 'error'`).run().changes;
}

// ---- Tự động quét: đầu vào rồi bán ra, mỗi VAT_AUTO_SYNC_MINUTES phút ----
async function runAll() {
  auto.lastRunAt = new Date().toISOString();
  for (const dir of ['in', 'out']) {
    const folder = dir === 'in' ? config.driveVatInputFolderId : config.driveVatOutputFolderId;
    if (!folder) continue;
    if (job && job.running) await new Promise(r => { const t = setInterval(() => { if (!job.running) { clearInterval(t); r(); } }, 5000); });
    await start(dir, null).promise;
  }
}

function scheduleAuto() {
  const minutes = parseInt(process.env.VAT_AUTO_SYNC_MINUTES, 10);
  const m = Number.isFinite(minutes) ? minutes : 60;
  if (m <= 0 || !drive.status().credentials || !(config.driveVatInputFolderId || config.driveVatOutputFolderId)) return;
  auto = { enabled: true, minutes: m, lastRunAt: null, nextRunAt: null };
  const loop = delay => {
    auto.nextRunAt = new Date(Date.now() + delay).toISOString();
    setTimeout(() => runAll().catch(e => console.error('[vat] auto', e.message)).finally(() => loop(m * 60 * 1000)), delay).unref();
  };
  loop(60 * 1000); // khởi động xong 1 phút thì quét (nối tiếp lượt bị ngắt nếu có)
  console.log(`[vat] tự động quét hóa đơn mỗi ${m} phút`);
}

module.exports = { sync, start, status, kind, resetErrors, scheduleAuto, MAX_ATTEMPTS };
