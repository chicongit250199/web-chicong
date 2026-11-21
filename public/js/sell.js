// Form bán hàng: gợi ý hàng tồn kho, chọn serial, giỏ nhiều món, popup xác nhận
window.sellForm = function (staffName, preset, build) {
  return {
    staffName: staffName,
    // Mở từ trang kho (?item=ID): chọn sẵn đúng món đó
    init: function () {
      if (build) {
        this.buildId = build.id; this.buildCode = build.code;
        this.cart = build.lines; this.customer_name = build.customer_name; this.customer_phone = build.customer_phone; this.delivery_address = build.delivery_address;
      }
      if (!preset) return;
      this.group = preset; this.q = preset.name; this.unitId = String(preset.selected);
      this.applyUnit();
    },
    q: '', results: [], open: false, loading: false, hi: -1, timer: null,
    group: null, unitId: '', price: '', payment: 'cash',
    customer_name: '', customer_phone: '', delivery_address: '', warranty: '', kind: 'repair',
    confirm: false, sending: false, error: '', success: '', confirmTime: '',
    buildId: null, buildCode: '',
    cart: [], sale_date: '', today: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), // các món đã thêm vào đơn: { item_id, name, serial, kind, price, warranty, label }

    get total() { return this.cart.reduce(function (s, l) { return s + Number(l.price || 0); }, 0); },
    get inCart() { return this.cart.filter(function (l) { return l.item_id; }).map(function (l) { return l.item_id; }); },
    // Serial còn chọn được (bỏ món đã có trong đơn)
    get freeUnits() { var ids = this.inCart; return this.group ? this.group.units.filter(function (u) { return ids.indexOf(u.id) < 0; }) : []; },
    get draft() { return this.q.trim().length > 0; },
    get allService() { return this.cart.length > 0 && this.cart.every(function (l) { return l.kind === 'repair'; }); },

    get unit() {
      if (!this.group) return null;
      var id = Number(this.unitId);
      return this.group.units.find(function (u) { return u.id === id; }) || null;
    },
    // Không chọn từ kho mà tự gõ tên -> dịch vụ / hàng ngoài kho
    get free() { return !this.group && this.q.trim().length > 0; },
    get hasSerials() { return this.group && this.group.units.some(function (u) { return u.serial; }); },
    get priceDisplay() { return this.price === '' ? '' : formatVnd(this.price); },

    search: function () {
      var self = this;
      clearTimeout(this.timer);
      this.group = null; this.unitId = '';
      if (!this.q.trim()) { this.results = []; this.open = false; return; }
      this.timer = setTimeout(function () {
        self.loading = true;
        api('/staff/api/inventory/suggest?q=' + encodeURIComponent(self.q.trim()))
          .then(function (d) { self.results = d.items; self.open = true; self.hi = d.items.length ? 0 : -1; })
          .catch(function (e) { self.error = e.message; })
          .finally(function () { self.loading = false; });
      }, 200);
    },
    move: function (d) { if (this.results.length) this.hi = (this.hi + d + this.results.length) % this.results.length; },
    choose: function (g) {
      g = g || this.results[this.hi];
      if (!g) return;
      var term = this.q.trim().toLowerCase();
      this.group = g; this.q = g.name; this.open = false;
      // Nếu tìm đúng serial thì chọn luôn; nếu không có serial thì lấy món nhập sớm nhất
      var units = this.freeUnits;
      if (!units.length) { this.error = 'Đã thêm hết số lượng còn trong kho của món này vào đơn.'; this.group = null; return; }
      var match = units.find(function (u) { return u.serial && u.serial.toLowerCase() === term; });
      var first = match || (this.hasSerials ? null : units[0]);
      this.unitId = first ? String(first.id) : (units.length === 1 ? String(units[0].id) : '');
      this.applyUnit();
    },
    applyUnit: function () {
      var u = this.unit;
      var p = (u && u.retail_price != null) ? u.retail_price : this.group && this.group.retail_price;
      this.price = p != null ? String(p) : '';
      var w = (u && u.warranty_out_months != null) ? u.warranty_out_months : this.group && this.group.warranty_out_months;
      this.warranty = w != null ? String(w) : '';
    },
    onPrice: function (e) { this.price = e.target.value.replace(/\D/g, ''); e.target.value = this.priceDisplay; },

    // Kiểm tra món đang nhập; trả về dòng giỏ hoặc null (kèm báo lỗi)
    currentLine: function () {
      if (this.group && !this.unit) { this.error = 'Chọn số Serial của món hàng.'; return null; }
      if (!this.group && !this.q.trim()) { this.error = 'Nhập tên hàng hóa / dịch vụ.'; return null; }
      if (this.price === '') { this.error = 'Nhập giá tiền.'; return null; }
      var u = this.unit;
      var w = this.warranty !== '' ? this.warranty : (u && u.warranty_out_months != null ? String(u.warranty_out_months) : '');
      return {
        item_id: u ? u.id : null, name: this.group ? this.group.name : this.q.trim(), serial: u ? u.serial : null,
        kind: this.group ? 'sale' : this.kind, price: this.price, warranty: this.warranty, warrantyShow: w === '' ? 0 : Number(w),
      };
    },
    clearLine: function () {
      this.q = ''; this.results = []; this.group = null; this.unitId = ''; this.price = ''; this.warranty = ''; this.open = false;
    },
    addLine: function () {
      this.error = ''; this.success = '';
      var line = this.currentLine();
      if (!line) return;
      this.cart.push(line);
      this.clearLine();
      if (this.$refs.q) this.$refs.q.focus();
    },
    removeLine: function (i) { this.cart.splice(i, 1); },
    // Dòng từ Build PC: đổi sang serial khác cùng món (không trùng dòng khác)
    unitChoices: function (l) {
      var used = this.cart.filter(function (x) { return x !== l && x.item_id; }).map(function (x) { return x.item_id; });
      return (l.choices || []).filter(function (u) { return used.indexOf(u.id) < 0; });
    },
    changeUnit: function (l, id) {
      var u = (l.choices || []).find(function (c) { return c.id === Number(id); });
      if (u) { l.item_id = u.id; l.serial = u.serial; }
    },

    openConfirm: function () {
      this.error = ''; this.success = '';
      // Đang nhập dở 1 món -> tự thêm vào đơn
      if (this.draft || this.group) { var line = this.currentLine(); if (!line) return; this.cart.push(line); this.clearLine(); }
      if (!this.cart.length) { this.error = 'Chưa có món nào trong đơn.'; return; }
      this.open = false;
      this.confirmTime = new Date().toLocaleString('vi-VN');
      this.confirm = true;
    },
    submit: function () {
      var self = this;
      this.sending = true;
      api('/staff/sell', { method: 'POST', body: {
        items: this.cart.map(function (l) { return { item_id: l.item_id, name: l.item_id ? '' : l.name, kind: l.kind, price: l.price, warranty_months: l.warranty }; }),
        payment_method: this.payment, sale_date: this.sale_date, build_id: this.buildId, customer_name: this.customer_name, customer_phone: this.customer_phone, delivery_address: this.delivery_address,
      } }).then(function (d) {
        self.success = d.message; self.confirm = false; self.reset();
      }).catch(function (e) { self.error = e.message; self.confirm = false; })
        .finally(function () { self.sending = false; });
    },
    reset: function () {
      this.q = ''; this.results = []; this.group = null; this.unitId = ''; this.price = ''; this.payment = 'cash';
      this.customer_name = ''; this.customer_phone = ''; this.delivery_address = ''; this.warranty = ''; this.kind = 'repair';
      this.cart = []; this.sale_date = ''; this.buildId = null; this.buildCode = '';
    },
  };
};
