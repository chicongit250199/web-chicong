'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs');

const config = require('./config');
const db = require('./db');
const SqliteStore = require('./db/sessionStore');
const { loadUser } = require('./middleware/auth');
const csrf = require('./middleware/csrf');
const locals = require('./middleware/locals');
const flash = require('./middleware/flash');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// CSP với nonce cho script inline; Alpine.js cần 'unsafe-eval'
app.use(require('./services/reqStats').middleware); // đếm request (trang Hệ thống)
app.use((req, res, next) => { res.locals.nonce = crypto.randomBytes(16).toString('base64'); next(); });
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-eval'", (req, res) => `'nonce-${res.locals.nonce}'`],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'frame-src': ["'self'", 'https://www.google.com', 'https://maps.google.com', 'https://drive.google.com'],
      'upgrade-insecure-requests': config.secureCookies ? [] : null,
    },
  },
  // Chạy LAN qua HTTP: tắt HSTS cho đến khi public HTTPS
  strictTransportSecurity: config.secureCookies,
  crossOriginOpenerPolicy: config.secureCookies,
  originAgentCluster: false,
}));

// Nén gzip phản hồi (HTML/CSS/JS/JSON nhỏ đi 5-10 lần) — bỏ qua luồng SSE thông báo
app.use(compression({ level: 6, threshold: 1024, filter: (req, res) => req.path !== '/manager/events' && req.path !== '/staff/events' && compression.filter(req, res) }));

// Phiên bản tài nguyên tĩnh: đổi khi build lại CSS/JS => trình duyệt tự lấy bản mới, còn lại cache lâu
const assetVersion = (() => {
  // Băm nội dung mọi file CSS/JS: sửa bất kỳ file nào => phiên bản đổi => trình duyệt tải bản mới
  const h = require('crypto').createHash('md5');
  for (const dir of ['public/css', 'public/js']) {
    for (const f of fs.readdirSync(path.join(__dirname, dir)).sort()) {
      if (/\.(css|js)$/.test(f)) h.update(fs.readFileSync(path.join(__dirname, dir, f)));
    }
  }
  return h.digest('hex').slice(0, 10);
})();
app.locals.v = assetVersion;
app.locals.partial = require('./services/partial');

app.use('/vendor/alpine.js', (req, res) => res.sendFile(require.resolve('alpinejs/dist/cdn.min.js'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '30d' : 0 }));

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(session({
  name: 'ccsid',
  secret: config.sessionSecret,
  store: new SqliteStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use(loadUser);
app.use(locals);
app.use(flash);

app.use(csrf);

app.use('/', require('./routes/auth'));
app.use('/staff', require('./routes/staff'));
app.use('/manager', require('./routes/manager'));
app.use('/', require('./routes/public'));

app.use((req, res) => res.status(404).render('error', { title: '404', message: 'Không tìm thấy trang.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  if (req.xhr || (req.get('accept') || '').includes('json')) return res.status(status).json({ error: err.expose ? err.message : 'Lỗi máy chủ' });
  res.status(status).render('error', { title: String(status), message: err.expose ? err.message : 'Có lỗi xảy ra, vui lòng thử lại.' });
});

if (process.env.BACKUP_DISABLED !== 'true') require('./services/backup').schedule(db);

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] Chí Công Computer chạy tại http://${config.host}:${config.port} (${config.isProd ? 'production' : 'development'})`);
  require('./services/vatSync').scheduleAuto();
  require('./services/revenueReport').schedule();
});

// Giữ kết nối lâu hơn để trình duyệt dùng lại (nhiều người dùng LAN)
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
