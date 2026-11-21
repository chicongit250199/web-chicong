'use strict';
// Biến mô tả / cấu hình dạng văn bản thuần (do người nhập hoặc AI viết) thành khối có cấu trúc để hiển thị đẹp

// Mô tả -> [{ type: 'h', text }, { type: 'p', text }, { type: 'ul', items: [] }]
// - Dòng ngắn VIẾT HOA (VD "THIẾT KẾ", "PIN & KẾT NỐI") hoặc kết thúc bằng ":" -> tiêu đề mục
// - Dòng bắt đầu bằng •, -, *, ✓, + -> gạch đầu dòng
function parseDescription(text) {
  const blocks = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = line.match(/^[•\-*✓✔+▪►]\s*(.+)$/);
    const letters = line.replace(/[^A-Za-zÀ-ỹ]/g, '');
    const isHeading = line.length <= 60 && !bullet && (
      (letters.length >= 3 && letters === letters.toUpperCase() && /[A-ZÀ-Ỹ]/.test(letters)) || /^[^.]{2,50}:$/.test(line));
    if (bullet) {
      flush();
      const last = blocks[blocks.length - 1];
      // "Tiêu đề: nội dung" trong gạch đầu dòng -> tách phần đậm
      const m = bullet[1].match(/^([^:]{2,40}):\s*(.+)$/);
      const item = m ? { strong: m[1], text: m[2] } : { text: bullet[1] };
      if (last && last.type === 'ul') last.items.push(item); else blocks.push({ type: 'ul', items: [item] });
    } else if (isHeading) {
      flush();
      blocks.push({ type: 'h', text: line.replace(/:$/, '') });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

// Cấu hình "Tên: giá trị" mỗi dòng -> [{ k, v }]; dòng không có ":" -> { v }
function parseSpecs(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim().replace(/^[•\-*]\s*/, '')).filter(Boolean).map(l => {
    const m = l.match(/^([^:]{1,40}):\s*(.+)$/);
    return m ? { k: m[1].trim(), v: m[2].trim() } : { v: l };
  });
}

// Viết hoa chữ cái đầu mỗi từ cho tiêu đề mục ("PIN & KẾT NỐI" -> "Pin & Kết Nối")
function titleCase(s) {
  return String(s).toLocaleLowerCase('vi').replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toLocaleUpperCase('vi'));
}

module.exports = { parseDescription, parseSpecs, titleCase };
