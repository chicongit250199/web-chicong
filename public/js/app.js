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
  window.api = async function (url, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content }, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }));
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Lỗi ' + res.status));
    return data;
  };

  // Bảng thông báo real-time (SSE) — base /manager (quản lý) hoặc /staff (nhân viên)
  var TYPE = {
    task_new: ['bg-blue-500', 'inbox'], task_processing: ['bg-amber-500', 'wrench'], task_done: ['bg-emerald-500', 'check'],
    task_unrepairable: ['bg-red-500', 'alert'], task_completed: ['bg-violet-500', 'checkCircle'], task_redo: ['bg-orange-500', 'refresh'],
    sale: ['bg-pink-500', 'cart'], product: ['bg-sky-500', 'upload'], inventory: ['bg-teal-500', 'archive'],
    task_deleted: ['bg-red-600', 'trash'], revenue_deleted: ['bg-red-600', 'trash'],
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
          if (document.hidden) disconnect(); else { refresh(); connect(); }
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

  window.formatVnd = function (n) {
    if (n === null || n === undefined || n === '') return '';
    var num = typeof n === 'number' ? n : Number(String(n).replace(/[^\d-]/g, '')) || 0;
    return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(num);
  };
})();
