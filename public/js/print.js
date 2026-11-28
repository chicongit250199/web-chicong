// Trang In tài liệu (nhân viên)
window.printPage = function () {
  var data = JSON.parse(document.getElementById('print-data').textContent);
  var def = (data.printers.filter(function (p) { return p.isDefault; })[0] || data.printers[0] || {}).name || '';
  var OK = /\.(pdf|jpe?g|png|txt)$/i;
  return {
    s: data, tab: location.hash === '#file' ? 'file' : 'ship', printer: def, files: [], copies: 1, fit: true, busy: false, drag: false, err: '', results: [], timer: null,
    init: function () { this.poll(); },
    setTab: function (t) { this.tab = t; history.replaceState(null, '', t === 'file' ? '#file' : location.pathname + location.search); },
    // hàng đợi tự cập nhật khi đang có lệnh in
    poll: function () {
      var self = this; clearTimeout(this.timer);
      this.timer = setTimeout(function () {
        if (document.hidden || !(self.s.jobs && self.s.jobs.length)) return self.poll();
        api('/staff/print/status').then(function (d) { self.s = d; }).catch(function () {}).finally(function () { self.poll(); });
      }, 4000);
    },
    ext: function (f) { var m = f.name.match(/\.(\w+)$/); return m ? m[1].toUpperCase() : '?'; },
    add: function (list) {
      this.err = '';
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!OK.test(f.name)) { this.err = 'Bỏ qua "' + f.name + '": chỉ in được PDF, JPG, PNG, TXT.'; continue; }
        if (f.size > 30 * 1048576) { this.err = 'Bỏ qua "' + f.name + '": file quá 30 MB.'; continue; }
        if (this.files.length >= 10) { this.err = 'Tối đa 10 file mỗi lần.'; break; }
        this.files.push(f);
      }
    },
    send: function () {
      var self = this; this.busy = true; this.err = ''; this.results = [];
      var fd = new FormData();
      fd.append('printer', this.printer); fd.append('copies', this.copies); fd.append('fit', this.fit ? '1' : '0');
      this.files.forEach(function (f) { fd.append('files', f); });
      api('/staff/print', { method: 'POST', body: fd }).then(function (d) {
        self.results = d.results; self.s = d;
        self.files = self.files.filter(function (f) { return d.results.some(function (r) { return !r.ok && r.file === f.name; }); });
      }).catch(function (e) { self.err = e.message; }).finally(function () { self.busy = false; });
    },
    cancel: function (j) {
      var self = this;
      uiConfirm('Hủy lệnh in "' + (j.title || j.id) + '"?', { ok: 'Hủy lệnh in', cancel: 'Không' }).then(function (ok) {
        if (!ok) return;
        api('/staff/print/jobs/' + encodeURIComponent(j.id) + '/cancel', { method: 'POST' }).then(function (d) { self.s = d; }).catch(function (e) { self.err = e.message; });
      });
    },
  };
};

// Phiếu gửi hàng: nhập người nhận -> in A4 (mặc định máy HP P2035). Nằm trong printPage() nên dùng được s (danh sách máy in)
window.shipForm = function () {
  var d = JSON.parse(document.getElementById('ship-data').textContent);
  return {
    d: d, busy: false, msg: '', ok: false, copies: 1, printer: '',
    f: { to_name: '', to_phone: '', to_addr: '', from_name: d.from.from_name, from_phone: d.from.from_phone, from_addr: d.from.from_addr, fragile: true },
    init: function () {
      var a4 = this.a4();
      this.printer = ((a4.filter(function (p) { return /2035/.test(p.name + ' ' + (p.info || '')); })[0]) || a4.filter(function (p) { return p.isDefault; })[0] || a4[0] || {}).name || '';
    },
    // máy in A4 (bỏ máy in bill 80mm)
    a4: function () {
      return (this.s && this.s.printers || []).filter(function (p) { return !(/raw/i.test(p.model || '') && !(p.pageSizes || []).length); });
    },
    names: function () {
      var seen = {}, out = [];
      this.d.recent.concat(this.d.partners).forEach(function (r) { if (!seen[r.n]) { seen[r.n] = 1; out.push(r); } });
      return out;
    },
    pick: function () {
      var n = this.f.to_name.trim(), r = this.names().filter(function (x) { return x.n === n; })[0];
      if (!r) return;
      if (r.p) this.f.to_phone = r.p;
      if (r.a) this.f.to_addr = r.a;
    },
    body: function () { return Object.assign({}, this.f, { fragile: this.f.fragile ? '1' : '0' }); },
    previewUrl: function () { return '/staff/print/ship/label?' + new URLSearchParams(this.body()).toString(); },
    send: function () {
      var self = this; this.busy = true; this.msg = '';
      api('/staff/print/ship', { method: 'POST', body: Object.assign(this.body(), { printer: this.printer, copies: this.copies }) }).then(function (r) {
        self.ok = true; self.msg = '✓ Đã gửi ' + r.copies + ' bản phiếu gửi hàng ra máy in ' + r.printer + '.';
        if (r.ship) self.d = r.ship;
      }).catch(function (e) { self.ok = false; self.msg = '✗ ' + e.message; }).finally(function () { self.busy = false; });
    },
  };
};
