'use strict';
// Link liên hệ nhanh từ số điện thoại trong settings

function digits(phone) { return String(phone || '').replace(/\D/g, ''); }

function intl(phone) {
  const d = digits(phone);
  return d.startsWith('0') ? '84' + d.slice(1) : d;
}

function links(phone) {
  const d = digits(phone);
  return {
    tel: `tel:${d}`,
    zalo: `https://zalo.me/${d}`,
    whatsapp: `https://wa.me/${intl(phone)}`,
  };
}

// map_embed có thể là URL hoặc nguyên thẻ <iframe> dán từ Google Maps; chỉ chấp nhận nguồn Google
function mapSrc(mapEmbed, address) {
  let src = String(mapEmbed || '').trim();
  const m = src.match(/src=["']([^"']+)["']/i);
  if (m) src = m[1];
  if (/^https:\/\/(www\.)?google\.[a-z.]+\/maps/i.test(src) || /^https:\/\/maps\.google\./i.test(src)) return src;
  return `https://www.google.com/maps?q=${encodeURIComponent(address || '')}&output=embed`;
}

module.exports = { links, mapSrc };
