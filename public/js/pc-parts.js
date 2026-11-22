// Báo giá linh kiện: form thêm/sửa (thông số theo nhóm + AI), sửa giá nhanh, AI hàng loạt, nhập kho từ món "Hàng đặt"
(function () {
  function vn(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim(); }

  // types: [[type, regexSource]], fields: {type: [[key, label, hint]]}
  window.pcPartForm = function (fields, types, specs, category) {
    return {
      category: category || '', specs: specs || {}, summary: '', sources: [], aiSources: '',
      busy: false, err: '', took: 0,
      get type() {
        var c = vn(this.category);
        for (var i = 0; i < types.length; i++) if (new RegExp(types[i][1]).test(c)) return types[i][0];
        return 'other';
      },
      get fieldList() { return fields[this.type] || fields.other; },
      val: function (name) { var el = this.$root.querySelector('[name="' + name + '"]'); return el ? el.value : ''; },
      research: function () {
        var self = this;
        var name = this.val('name').trim();
        if (name.length < 3) { this.err = 'Nhập tên linh kiện trước.'; return; }
        if (!this.category.trim()) { this.err = 'Chọn nhóm trước.'; return; }
        this.err = ''; this.busy = true;
        api('/manager/api/pc-parts/ai', { method: 'POST', body: { name: name, category: this.category, condition: this.val('condition') } })
          .then(function (d) {
            var s = Object.assign({}, self.specs);
            Object.keys(d.specs || {}).forEach(function (k) { s[k] = d.specs[k]; });
            self.specs = s;
            var sum = self.$root.querySelector('[name="summary"]');
            if (sum && d.summary) sum.value = d.summary;
            self.sources = d.sources || [];
            self.aiSources = JSON.stringify(self.sources);
            self.took = d.took;
          })
          .catch(function (e) { self.err = e.message; })
          .finally(function () { self.busy = false; });
      },
    };
  };

  // Sửa giá nhanh ngay trên danh sách
  window.quickPrice = function (id, price) {
    return {
      editing: false, raw: price == null ? '' : String(price), saved: price, busy: false,
      get display() { return this.raw === '' ? '' : formatVnd(this.raw); },
      onInput: function (e) { this.raw = e.target.value.replace(/\D/g, ''); e.target.value = this.display; },
      open: function () { this.editing = true; var self = this; this.$nextTick(function () { var i = self.$refs.inp; if (i) { i.focus(); i.select(); } }); },
      save: function () {
        var self = this;
        if (String(this.saved == null ? '' : this.saved) === this.raw) { this.editing = false; return; }
        this.busy = true;
        api('/manager/pc-parts/' + id + '/price', { method: 'POST', body: { price: this.raw } })
          .then(function (d) { self.saved = d.price; self.editing = false; })
          .catch(function (e) { alert(e.message); })
          .finally(function () { self.busy = false; });
      },
      cancel: function () { this.raw = this.saved == null ? '' : String(this.saved); this.editing = false; },
    };
  };

  // AI tra hàng loạt: bấm chạy, theo dõi tiến độ
  window.aiBatch = function (initial) {
    return {
      s: initial || {}, timer: null,
      init: function () { if (this.s.running) this.poll(); },
      call: function (url, method) {
        var self = this;
        return api(url, { method: method || 'GET' }).then(function (d) { self.s = d; return d; }).catch(function (e) { self.s = Object.assign({}, self.s, { error: e.message }); });
      },
      start: function () { var self = this; this.call('/manager/pc-parts/ai-batch/start', 'POST').then(function () { self.poll(); }); },
      stop: function () { this.call('/manager/pc-parts/ai-batch/stop', 'POST'); },
      poll: function () {
        var self = this;
        clearTimeout(this.timer);
        this.timer = setTimeout(function () {
          self.call('/manager/pc-parts/ai-batch/status').then(function () { if (self.s.running) self.poll(); });
        }, 3000);
      },
      get pct() { return this.s.total ? Math.round((this.s.done + this.s.failed) / this.s.total * 100) : 0; },
    };
  };

  // Nhân viên gửi yêu cầu nhập hàng (trang Giá Linh Kiện chỉ xem) -> món chuyển "Chờ nhập kho"
  window.partRequest = function () {
    return {
      rq: null, qty: 1, note: '', busy: false, err: '',
      ask: function (part) { this.rq = part; this.qty = 1; this.note = ''; this.err = ''; },
      send: function () {
        var self = this;
        if (!this.rq) return;
        this.busy = true; this.err = '';
        api('/staff/pc-parts/' + this.rq.id + '/request', { method: 'POST', body: { qty: this.qty, note: this.note } })
          .then(function () { window.location.reload(); })
          .catch(function (e) { self.err = e.message; self.busy = false; });
      },
    };
  };

  // Nhập kho cho món "Hàng đặt" (dùng ở Báo giá linh kiện và Build PC). onDone(newQty) để cập nhật nhãn.
  window.receiveStock = function () {
    return {
      rc: null, serials: '', quantity: 1, supplier: '', techRaw: '', import_date: '', rcBusy: false, rcErr: '',
      get techDisplay() { return this.techRaw === '' ? '' : formatVnd(this.techRaw); },
      onTech: function (e) { this.techRaw = e.target.value.replace(/\D/g, ''); e.target.value = this.techDisplay; },
      get serialCount() { return this.serials.split(/[\r\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean).length; },
      openReceive: function (part, onDone) {
        this.rc = part; this.rcDone = onDone || null; this.serials = ''; this.quantity = 1; this.supplier = ''; this.techRaw = ''; this.rcErr = '';
        this.import_date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      },
      submitReceive: function () {
        var self = this;
        if (!this.rc) return;
        this.rcBusy = true; this.rcErr = '';
        api('/staff/pc-parts/' + this.rc.id + '/receive', { method: 'POST', body: {
          serials: this.serials, quantity: this.quantity, supplier: this.supplier, tech_price: this.techRaw, import_date: this.import_date,
        } }).then(function (d) {
          if (self.rcDone) self.rcDone(d.stock, d);
          else window.location.reload();
          self.rc = null;
        }).catch(function (e) { self.rcErr = e.message; })
          .finally(function () { self.rcBusy = false; });
      },
    };
  };
})();
