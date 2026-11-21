'use strict';
// Quét thư mục Drive -> đọc hóa đơn (XML trước, PDF/ảnh qua Gemini) -> lưu vat_invoices + vat_items
const path = require('path');
const db = require('../db');
const config = require('../config');
const drive = require('./driveService');
const { parseInvoiceXml } = require('./vatXml');
const aiService = require('./aiService');
const { stripVi } = require('./inventory');

const MAX_PER_RUN = 15; // mỗi lần bấm "Cập nhật" xử lý tối đa 15 hóa đơn (PDF qua AI mất vài giây/file)

const q = {
  known: db.prepare('SELECT drive_file_id FROM vat_drive_files WHERE status <> ?'),
  markFile: db.prepare(`INSERT INTO vat_drive_files (drive_file_id, direction, file_name, mime_type, invoice_id, status, error)
    VALUES (@id, @direction, @name, @mime, @invoice_id, @status, @error)
    ON CONFLICT(drive_file_id) DO UPDATE SET invoice_id = excluded.invoice_id, status = excluded.status, error = excluded.error, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
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

async function sync(direction) {
  const folder = direction === 'in' ? config.driveVatInputFolderId : config.driveVatOutputFolderId;
  if (!folder) {
    const e = new Error(`Chưa cấu hình ${direction === 'in' ? 'DRIVE_VAT_INPUT_FOLDER_ID' : 'DRIVE_VAT_OUTPUT_FOLDER_ID'} trong .env`);
    e.status = 400; e.expose = true; throw e;
  }
  // Không quét thư mục con thuộc chiều ngược lại (VD "HĐ Bán ra" nằm trong thư mục Đầu vào)
  const other = direction === 'in' ? /ban\s*ra|xuat/ : /dau\s*vao|mua\s*vao|nhap/;
  const files = (await drive.listFiles(folder, 1, name => other.test(stripVi(name).toLowerCase()))).filter(kind);
  const known = new Set(q.known.all('error').map(r => r.drive_file_id));
  const fresh = files.filter(f => !known.has(f.id));

  // Ghép XML + PDF cùng tên: đọc XML (chính xác), PDF chỉ để gắn link xem
  const groups = new Map();
  for (const f of fresh) {
    const k = baseName(f.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const result = { found: fresh.length, added: 0, duplicates: 0, errors: [], remaining: 0, usedAi: 0 };
  let processed = 0;
  for (const group of groups.values()) {
    if (processed >= MAX_PER_RUN) { result.remaining += group.length; continue; }
    const xml = group.find(f => kind(f) === 'xml');
    const pdf = group.find(f => kind(f) === 'pdf');
    const main = xml || pdf || group[0];
    const others = group.filter(f => f !== main);
    processed++;
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
      // Thiếu API key / quyền: dừng sớm, không lặp lỗi cho mọi file
      if (err.status === 400) break;
    }
  }
  return result;
}

module.exports = { sync, kind };
