// Trang Hệ thống: lấy /manager/system.json mỗi 5 giây
window.systemPage = function () {
  var GB = 1024 * 1024 * 1024, MB = 1024 * 1024;
  return {
    d: null, err: '', timer: null, updated: '',
    init: function () { this.load(); },
    load: function () {
      var self = this;
      api('/manager/system.json').then(function (d) { self.d = d; self.err = ''; self.updated = new Date().toLocaleTimeString('vi-VN'); })
        .catch(function (e) { self.err = e.message; })
        .finally(function () { clearTimeout(self.timer); self.timer = setTimeout(function () { self.load(); }, 5000); });
    },

    // ---- định dạng ----
    gb: function (b) { return (b / GB).toFixed(b >= 100 * GB ? 0 : 1) + ' GB'; },
    size: function (b) { return b >= GB ? (b / GB).toFixed(1) + ' GB' : b >= MB ? (b / MB).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; },
    dur: function (s) {
      s = Math.floor(s); var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
      return (d ? d + ' ngày ' : '') + (d || h ? h + ' giờ ' : '') + m + ' phút';
    },
    // tốc độ mạng: byte/giây -> bit/giây (đơn vị nhà mạng hay dùng)
    bps: function (b) {
      var v = (b || 0) * 8;
      return v >= 1e9 ? (v / 1e9).toFixed(2) + ' Gbps' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + ' Mbps' : v >= 1e3 ? Math.round(v / 1e3) + ' Kbps' : Math.round(v) + ' bps';
    },
    linkSpeed: function (m) { return m == null ? '—' : m >= 1000 ? (m / 1000) + ' Gbps' : m + ' Mbps'; },
    get netUp() { return this.d && this.d.network ? this.d.network.filter(function (n) { return n.up; }) : []; },
    get netRx() { return this.netUp.reduce(function (s, n) { return s + n.rx; }, 0); },
    get netTx() { return this.netUp.reduce(function (s, n) { return s + n.tx; }, 0); },
    // thang biểu đồ mạng: đỉnh cao nhất trong 10 phút (tối thiểu 1 Mbps để đường không nhảy loạn khi mạng rảnh)
    get netMax() {
      var h = this.d ? this.d.history : [];
      return Math.max.apply(null, [125000].concat(h.map(function (p) { return Math.max(p.rx || 0, p.tx || 0); })));
    },
    time: function (iso) { return iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—'; },

    // ---- số liệu tổng hợp ----
    get cpuTemps() { return this.d ? this.d.temps.filter(function (t) { return t.chip === 'coretemp'; }) : []; },
    get otherTemps() { return this.d ? this.d.temps.filter(function (t) { return t.chip !== 'coretemp'; }) : []; },
    get maxTemp() { var t = this.cpuTemps.length ? this.cpuTemps : (this.d ? this.d.temps : []); return t.length ? Math.max.apply(null, t.map(function (x) { return x.value; })) : null; },
    get memPct() { var m = this.d.memory; return Math.round((1 - m.available / m.total) * 100); },
    get swapPct() { var m = this.d.memory; return m.swapTotal ? Math.round((1 - m.swapFree / m.swapTotal) * 100) : 0; },
    diskPct: function (k) { return Math.round((1 - k.free / k.total) * 100); },
    get loadPct() { return Math.round(this.d.cpu.load[0] / this.d.cpu.cores * 100); },

    // ---- trạng thái: ok / warn / bad (luôn kèm chữ, không chỉ dựa vào màu) ----
    level: function (v, warn, bad) { return v == null ? 'ok' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok'; },
    tempLevel: function (v) { return this.level(v, 75, 85); },
    pctLevel: function (v) { return this.level(v, 80, 92); },
    label: function (l) { return { ok: 'Bình thường', warn: 'Cần chú ý', bad: 'Nguy hiểm' }[l]; },
    text: function (l) { return { ok: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' }[l]; },
    bar: function (l) { return { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500' }[l]; },
    badge: function (l) { return { ok: 'badge-green', warn: 'badge-amber', bad: 'badge-red' }[l]; },
    get overall() {
      if (!this.d) return 'ok';
      var ls = [this.tempLevel(this.maxTemp), this.pctLevel(this.d.cpu.usage), this.pctLevel(this.memPct)].concat(this.d.disks.map(function (k) { return this.pctLevel(this.diskPct(k)); }, this));
      return ls.indexOf('bad') >= 0 ? 'bad' : ls.indexOf('warn') >= 0 ? 'warn' : 'ok';
    },

    // ---- biểu đồ nhỏ 10 phút (SVG polyline, 1 chuỗi, có vùng tô nhạt) ----
    spark: function (key, max) {
      var h = this.d ? this.d.history.filter(function (p) { return p[key] != null; }) : [];
      if (h.length < 2) return { line: '', area: '' };
      var W = 300, H = 60, n = h.length;
      var pts = h.map(function (p, i) { return [(i / (n - 1)) * W, H - Math.min(1, p[key] / max) * (H - 4) - 2]; });
      var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
      return { line: line, area: '0,' + H + ' ' + line + ' ' + W + ',' + H };
    },
    histRange: function (key) {
      var v = this.d ? this.d.history.map(function (p) { return p[key]; }).filter(function (x) { return x != null; }) : [];
      return v.length ? { min: Math.min.apply(null, v), max: Math.max.apply(null, v) } : null;
    },
  };
};
