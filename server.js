'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const config = require('./config');
const db = require('./db');
const SqliteStore = require('./db/sessionStore');
const { loadUser } = require('./middleware/auth');
const csrf = require('./middleware/csrf');
const locals = require('./middleware/locals');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// CSP với nonce cho script inline; Alpine.js cần 'unsafe-eval'
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

app.use('/vendor/alpine.js', (req, res) => res.sendFile(require.resolve('alpinejs/dist/cdn.min.js'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));

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

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] Chí Công Computer chạy tại http://${config.host}:${config.port} (${config.isProd ? 'production' : 'development'})`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
