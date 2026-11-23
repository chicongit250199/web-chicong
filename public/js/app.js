// JS dùng chung toàn site (nạp trước Alpine)
(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function getMode() { try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; } }
  function apply(mode) {
    var dark = mode === 'dark' || (mode === 'auto' && mq.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = mode;
  }
  mq.addEventListener('change', function () { if (getMode() === 'auto') apply('auto'); });

  window.themeSwitch = function () {
    return {
      mode: getMode(),
      set: function (m) {
        this.mode = m;
        try { localStorage.setItem('theme', m); } catch (e) {}
        apply(m);
      },
    };
  };

  // fetch có kèm CSRF token + JSON
  // Báo về máy chủ khi trang / lệnh tải chậm (> 3 giây) để tìm nguyên nhân: dò tên, kết nối, chờ máy chủ hay dựng trang
  function perfReport(d) {
    try {
      d.host = location.host; d.ua = navigator.userAgent;
      var body = JSON.stringify(d);
      if (!(navigator.sendBeacon && navigator.sendBeacon('/perf-beacon', body))) fetch('/perf-beacon', { method: 'POST', body: body, keepalive: true });
    } catch (e) {}
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      try {
        var n = performance.getEntriesByType('navigation')[0];
        if (!n) return;
        var total = n.loadEventStart || n.domContentLoadedEventEnd;
        if (total < 3000) return;
        perfReport({
          kind: 'page', path: location.pathname + location.search, nav: n.type, total: total,
          stall: n.domainLookupStart - n.fetchStart,   // chờ trước khi dò tên (hàng đợi trình duyệt, chuyển hướng)
          dns: n.domainLookupEnd - n.domainLookupStart, // dò tên chicongcomputer.local
          connect: n.connectEnd - n.connectStart,       // mở kết nối TCP
          queue: n.requestStart - n.connectEnd,         // chờ gửi request (hết lượt kết nối)
          ttfb: n.responseStart - n.requestStart,       // máy chủ xử lý + mạng
          download: n.responseEnd - n.responseStart,
          dom: n.domContentLoadedEventEnd - n.responseEnd, // dựng trang, chạy JS
        });
      } catch (e) {}
    }, 0);
  });

  window.api = async function (url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var t0 = performance.now();
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    var took = performance.now() - t0;
    if (took > 3000) perfReport({ kind: 'api', path: url, total: took, ttfb: took });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Lỗi ' + res.status));
    return data;
  };

  // Bảng thông báo real-time (SSE) — base /manager (quản lý) hoặc /staff (nhân viên)
  var TYPE = {
    task_new: ['bg-blue-500', 'inbox'], task_processing: ['bg-amber-500', 'wrench'], task_done: ['bg-emerald-500', 'check'],
    task_unrepairable: ['bg-red-500', 'alert'], task_completed: ['bg-violet-500', 'checkCircle'], task_redo: ['bg-orange-500', 'refresh'], task_edited: ['bg-sky-500', 'edit'],
    sale: ['bg-pink-500', 'cart'], product: ['bg-sky-500', 'upload'], inventory: ['bg-teal-500', 'archive'],
    task_deleted: ['bg-red-600', 'trash'], revenue_deleted: ['bg-red-600', 'trash'], debt_payment: ['bg-emerald-600', 'checkCircle'],
  };
  var ICONS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>', wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>', alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
    checkCircle: '<path d="M22 4L12 14l-3-3"/><circle cx="12" cy="12" r="9"/>', refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    upload: '<path d="M17 8l-5-5-5 5M12 3v12"/>', trash: '<path d="M3 6h18M19 6l-1 14H6L5 6M9 6V4h6v2"/>', archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11h16V8"/>',
  };
  // Tiếng "ting" 3 nốt đi lên kiểu iPhone, tạo bằng Web Audio (không cần file)
  var chime = (function () {
    var ctx = null;
    function get() {
      if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function note(c, freq, at, len) {
      var o = c.createOscillator(); var o2 = c.createOscillator(); var g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o2.type = 'triangle'; o2.frequency.value = freq * 2; // bồi âm cho tiếng trong như chuông
      var g2 = c.createGain(); g2.gain.value = 0.15;
      o.connect(g); o2.connect(g2); g2.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.22, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.start(at); o2.start(at); o.stop(at + len + 0.02); o2.stop(at + len + 0.02);
    }
    return {
      unlock: function () { get(); },
      play: function () {
        var c = get();
        if (!c || c.state !== 'running') return;
        var t = c.currentTime + 0.02;
        note(c, 1046.5, t, 0.35);        // C6
        note(c, 1318.5, t + 0.11, 0.35); // E6
        note(c, 1568.0, t + 0.22, 0.6);  // G6
      },
    };
  })();

  // ---- Cập nhật trang theo thời gian thực ----
  // Có thông báo mới (SSE) -> tải lại ngầm trang hiện tại, thay phần <main> + số trên menu, giữ nguyên vị trí cuộn.
  // Không làm khi người dùng đang thao tác: popup đang mở, đang gõ / đã sửa ô nhập, hoặc trang nhập liệu (bán hàng, nhận máy...).
  // Khi đó vẫn cập nhật các khung chỉ-để-xem đánh dấu data-live="tên" (vd "Bán gần đây" ở trang bán hàng) — không đụng ô đang nhập.
  var liveRefresh = (function () {
    var SKIP = /^\/(staff\/(sell|build|tasks\/new|inventory\/new|products\/new)|manager\/(system|import|pc-parts\/new|products\/\d+))|\/(edit|new|print)(\/|$)/;
    var timer = null, busy = false, again = false, dirty = false;
    document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('main form')) dirty = true; }, true);
    function userBusy() {
      if (dirty || SKIP.test(location.pathname)) return true;
      if (document.querySelector('.modal-backdrop')) return true;
      var a = document.activeElement;
      return !!(a && a.closest('main') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'button' && a.type !== 'submit');
    }
    function swap(sel, doc) {
      var cur = document.querySelectorAll(sel), next = doc.querySelectorAll(sel);
      if (cur.length !== next.length) return false;
      for (var i = 0; i < cur.length; i++) if (cur[i].innerHTML !== next[i].innerHTML) cur[i].innerHTML = next[i].innerHTML;
      return true;
    }
    // Khung data-live: khớp theo tên, bỏ qua khung đang chứa ô người dùng đang gõ
    function swapLive(doc) {
      var a = document.activeElement;
      document.querySelectorAll('[data-live]').forEach(function (el) {
        var nx = doc.querySelector('[data-live="' + el.getAttribute('data-live') + '"]');
        if (!nx || (a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
        if (el.innerHTML !== nx.innerHTML) el.innerHTML = nx.innerHTML;
      });
    }
    function run() {
      timer = null;
      if (document.hidden) return;
      if (busy) { again = true; return; }
      busy = true;
      var onlyNav = userBusy();
      fetch(location.href, { credentials: 'same-origin', headers: { 'X-Live-Refresh': '1' } })
        .then(function (r) { if (!r.ok || r.redirected) throw 0; return r.text(); })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          swap('[data-live-nav]', doc);
          if (!onlyNav && !userBusy()) swap('main', doc);
          else swapLive(doc);
        })
        .catch(function () {})
        .then(function () { busy = false; if (again) { again = false; schedule(); } });
    }
    function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(run, 400); }
    return { schedule: schedule };
  })();
  window.liveRefresh = liveRefresh;

  window.notifPanel = function () {
    return {
      items: [], unread: 0, live: false, toasts: [], open: false, ring: false, pop: false, me: '', base: '/manager', sound: true,
      init: function () {
        var self = this;
        try { var d = JSON.parse(document.getElementById('notif-data').textContent); self.items = d.items; self.unread = d.unread; self.me = d.me || ''; self.base = d.base || '/manager'; } catch (e) {}
        try { self.sound = localStorage.getItem('notifSound') !== 'off'; } catch (e) {}
        // Trình duyệt chỉ cho phát âm thanh sau khi người dùng đã bấm / gõ phím trên trang -> "mở khóa" ở lần tương tác đầu
        var unlock = function () { chime.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
        window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
        self.es = null;
        // Chỉ giữ kết nối SSE khi tab đang hiển thị: trình duyệt giới hạn 6 kết nối/máy chủ,
        // mở nhiều tab mà tab nào cũng giữ SSE thì trang mới sẽ bị treo.
        var connect = function () {
          if (self.es) return;
          var es = new EventSource(self.base + '/events');
          self.es = es;
          es.onopen = function () { self.live = true; };
          es.onerror = function () { self.live = false; };
          es.addEventListener('notification', function (ev) {
            var n = JSON.parse(ev.data);
            if (self.items.some(function (x) { return x.id === n.id; })) return;
            liveRefresh.schedule(); // cập nhật nội dung trang (danh sách task, số trên menu) theo thay đổi mới
            self.items.unshift(n);
            if (self.items.length > 60) self.items.pop();
            self.unread++;
            self.alert();
            if (self.sound && n.actor_name !== self.me) chime.play(); // không kêu với thao tác của chính mình
            if (self.open) return; // đang mở khung thì không cần banner
            var t = Object.assign({ leaving: false }, n);
            self.toasts.push(t);
            setTimeout(function () { self.dismiss(t); }, 5000);
          });
        };
        var disconnect = function () { if (self.es) { self.es.close(); self.es = null; self.live = false; } };
        var refresh = function () {
          api(self.base + '/notifications.json').then(function (d) { self.items = d.items; self.unread = d.unread; }).catch(function () {});
        };
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) disconnect(); else { refresh(); connect(); liveRefresh.schedule(); }
        });
        window.addEventListener('pagehide', disconnect);
        if (!document.hidden) connect();
        setInterval(function () { self.items = self.items.slice(); }, 60000); // cập nhật "x phút trước"
      },
      // chuông lắc + số chưa đọc nảy lên
      alert: function () {
        var self = this;
        this.ring = false; this.pop = false;
        requestAnimationFrame(function () { self.ring = true; self.pop = true; });
        clearTimeout(this._ringT);
        this._ringT = setTimeout(function () { self.ring = false; self.pop = false; }, 1200);
      },
      // banner thu nhỏ bay vào nút chuông rồi biến mất
      dismiss: function (t) {
        var self = this;
        var cur = this.toasts.find(function (x) { return x.id === t.id; });
        if (!cur || cur.leaving) return;
        cur.leaving = true;
        setTimeout(function () { self.toasts = self.toasts.filter(function (x) { return x.id !== t.id; }); }, 450);
      },
      toggleSound: function () {
        this.sound = !this.sound;
        try { localStorage.setItem('notifSound', this.sound ? 'on' : 'off'); } catch (e) {}
        if (this.sound) { chime.unlock(); chime.play(); } // nghe thử
      },
      toggle: function () {
        this.open = !this.open;
        if (this.open) this.toasts.forEach(this.dismiss.bind(this));
      },
      markRead: function () {
        var self = this;
        api(this.base + '/notifications/read', { method: 'POST' }).then(function () {
          self.unread = 0; self.items = self.items.map(function (n) { return Object.assign({}, n, { is_read: 1 }); });
        });
      },
      typeColor: function (t) { return (TYPE[t] || ['bg-slate-500'])[0]; },
      typeIcon: function (t) {
        var k = (TYPE[t] || [null, 'check'])[1];
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">' + ICONS[k] + '</svg>';
      },
      timeAgo: window.timeAgo,
    };
  };

  window.timeAgo = function (iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return Math.floor(s / 60) + ' phút trước';
    if (s < 86400) return Math.floor(s / 3600) + ' giờ trước';
    return new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // Ô nhập tiền: hiển thị 1.500.000, gửi lên số nguyên
  window.moneyInput = function (initial) {
    return {
      raw: initial == null || initial === '' ? '' : String(initial),
      get display() { return this.raw === '' ? '' : formatVnd(this.raw); },
      onInput: function (e) { this.raw = e.target.value.replace(/\D/g, ''); e.target.value = this.display; },
    };
  };

  // ---------- Hộp xác nhận giữa màn hình (thay confirm() mặc định của trình duyệt) ----------
  // uiConfirm('Xóa ...?', { title, ok, tone: 'danger' | 'warning' | 'info' }) -> Promise<boolean>
  // Khai báo trong HTML: <form data-confirm="Xóa ...?"> hoặc <button data-confirm="..."> (tùy chọn data-confirm-ok, data-confirm-tone)
  var CF_ICON = {
    danger: '<path d="M3 6h18M19 6l-1 14H6L5 6M9 6V4h6v2M10 11v6M14 11v6"/>',
    warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  };
  var CF_TONE = {
    danger: { ring: 'bg-red-100 text-red-600 ring-8 ring-red-50 dark:bg-red-950 dark:text-red-400 dark:ring-red-950/40', ok: 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500/40', bar: 'from-red-500 to-rose-500', title: 'Xác nhận xóa', okText: 'Xóa' },
    warning: { ring: 'bg-amber-100 text-amber-600 ring-8 ring-amber-50 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-950/40', ok: 'bg-amber-500 hover:bg-amber-600 focus-visible:ring-amber-500/40', bar: 'from-amber-400 to-orange-500', title: 'Xác nhận', okText: 'Đồng ý' },
    info: { ring: 'bg-brand-100 text-brand-600 ring-8 ring-brand-50 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-950/40', ok: 'bg-brand-600 hover:bg-brand-700 focus-visible:ring-brand-500/40', bar: 'from-brand-500 to-sky-500', title: 'Xác nhận', okText: 'Đồng ý' },
  };
  function guessTone(msg) { return /^\s*(xóa|xoá|hủy|huỷ|bỏ|ngắt|hoàn tác)/i.test(msg) ? 'danger' : 'warning'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  window.uiConfirm = function (message, opts) {
    opts = opts || {};
    var tone = CF_TONE[opts.tone] ? opts.tone : guessTone(message);
    var t = CF_TONE[tone];
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var wrap = document.createElement('div');
      wrap.className = 'ui-confirm fixed inset-0 z-[90] grid place-items-center p-4';
      wrap.setAttribute('role', 'alertdialog'); wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML =
        '<div class="ui-confirm-bg absolute inset-0 bg-slate-950/55 backdrop-blur-sm" data-cancel></div>' +
        '<div class="ui-confirm-box relative w-full max-w-md overflow-hidden rounded-2xl bg-white text-center shadow-2xl ring-1 ring-black/5 dark:bg-slate-900 dark:ring-white/10">' +
          '<div class="h-1.5 bg-gradient-to-r ' + t.bar + '"></div>' +
          '<div class="px-6 pb-6 pt-7">' +
            '<div class="ui-confirm-icon mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full ' + t.ring + '">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-8 w-8">' + CF_ICON[tone] + '</svg></div>' +
            '<h3 class="text-lg font-bold text-slate-900 dark:text-white">' + esc(opts.title || t.title) + '</h3>' +
            '<p class="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">' + esc(message) + '</p>' +
            '<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">' +
              '<button type="button" data-cancel class="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:min-w-28 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">' + esc(opts.cancel || 'Hủy') + '</button>' +
              '<button type="button" data-ok class="rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-lg outline-none focus-visible:ring-4 sm:min-w-28 ' + t.ok + '">' + esc(opts.ok || t.okText) + '</button>' +
            '</div></div></div>';
      function close(v) {
        document.removeEventListener('keydown', onKey, true);
        wrap.classList.add('ui-confirm-out');
        setTimeout(function () { wrap.remove(); }, 160);
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(!(document.activeElement && document.activeElement.hasAttribute('data-cancel'))); }
      }
      wrap.addEventListener('click', function (e) {
        if (e.target.closest('[data-ok]')) close(true);
        else if (e.target.closest('[data-cancel]')) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector('[data-ok]').focus();
    });
  };
  // Form / nút có data-confirm: chặn gửi, hỏi bằng hộp xác nhận, đồng ý thì gửi lại (giữ formaction của nút)
  function askThen(el, form, submitter) {
    uiConfirm(el.getAttribute('data-confirm'), { ok: el.getAttribute('data-confirm-ok') || undefined, tone: el.getAttribute('data-confirm-tone') || undefined })
      .then(function (ok) {
        if (!ok) return;
        form._cfOk = true;
        if (form.requestSubmit) form.requestSubmit(submitter || undefined); else form.submit();
      });
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-confirm], input[type=submit][data-confirm]');
    if (!btn || !btn.form) return;
    if (btn.form._cfOk) return;
    e.preventDefault(); e.stopImmediatePropagation();
    askThen(btn, btn.form, btn);
  }, true);
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form._cfOk) { form._cfOk = false; return; } // đã đồng ý -> cho gửi
    if (!form.hasAttribute('data-confirm')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    askThen(form, form, e.submitter);
  }, true);

  window.formatVnd = function (n) {
    if (n === null || n === undefined || n === '') return '';
    var num = typeof n === 'number' ? n : Number(String(n).replace(/[^\d-]/g, '')) || 0;
    return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(num);
  };
})();
