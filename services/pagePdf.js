'use strict';
// Dựng trang in phiếu (HTML của chính web) thành PDF bằng Chrome không giao diện, để gửi ra máy in trên NUC.
// Chrome mở trang qua 127.0.0.1 với cookie đăng nhập của người bấm in -> phiếu giống hệt khi xem trên máy.
// Giữ 1 trình duyệt dùng chung, tự tắt sau 5 phút không in để nhả RAM.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const CHROME_DIR = process.env.CHROME_HEADLESS_DIR || path.join(os.homedir(), '.cache', 'chicong-chrome');
const IDLE_MS = 5 * 60 * 1000;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(CHROME_DIR, 'chrome-headless-shell');
  if (!fs.existsSync(base)) return null;
  const vers = fs.readdirSync(base).sort().reverse();
  for (const v of vers) {
    const p = path.join(base, v, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let browserP = null, idle = null, queue = Promise.resolve();
function getBrowser() {
  if (!browserP) {
    const exe = chromePath();
    if (!exe) return Promise.reject(new Error('Chưa cài Chrome headless (npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/chicong-chrome)'));
    const puppeteer = require('puppeteer-core');
    browserP = puppeteer.launch({
      executablePath: exe, headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--font-render-hinting=none'],
    }).then(b => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch(e => {
        browserP = null;
        if (/shared libraries|error while loading/i.test(e.message)) e.message = 'Máy chủ thiếu thư viện cho Chrome — chạy: sudo bash scripts/setup-print-pdf.sh';
        throw e;
      });
  }
  clearTimeout(idle);
  return browserP;
}
function scheduleClose() {
  clearTimeout(idle);
  idle = setTimeout(() => { const p = browserP; browserP = null; if (p) p.then(b => b.close()).catch(() => {}); }, IDLE_MS);
  idle.unref();
}

// urlPath: đường dẫn nội bộ (đã kiểm tra), cookieHeader: header Cookie của người bấm in
function render(urlPath, cookieHeader) {
  const job = queue.then(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      const origin = `http://127.0.0.1:${config.port}`;
      const cookies = String(cookieHeader || '').split(/;\s*/).map(c => { const i = c.indexOf('='); return i > 0 ? { name: c.slice(0, i), value: c.slice(i + 1), url: origin } : null; }).filter(Boolean);
      if (cookies.length) await page.setCookie(...cookies);
      await page.emulateMediaType('print');
      const res = await page.goto(origin + urlPath, { waitUntil: 'networkidle0', timeout: 30000 });
      if (!res || !res.ok()) throw new Error(`Không mở được phiếu (mã ${res ? res.status() : '?'})`);
      if (/\/login(\?|$)/.test(page.url())) throw new Error('Phiên đăng nhập hết hạn, tải lại trang');
      await page.evaluate(() => document.fonts && document.fonts.ready);
      return await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
    } finally {
      await page.close().catch(() => {});
      scheduleClose();
    }
  });
  queue = job.catch(() => {}); // in lần lượt, Celeron yếu
  return job;
}

module.exports = { render, chromePath };
