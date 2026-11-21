// Form bán hàng: gợi ý hàng tồn kho, chọn serial, popup xác nhận
window.sellForm = function (staffName) {
  return {
    staffName: staffName,
    q: '', results: [], open: false, loading: false, hi: -1, timer: null,
    group: null, unitId: '', price: '', payment: 'cash',
    customer_name: '', customer_phone: '', delivery_address: '', warranty: '',
    confirm: false, sending: false, error: '', success: '', confirmTime: '',

    get unit() {
      if (!this.group) return null;
      var id = Number(this.unitId);
      return this.group.units.find(function (u) { return u.id === id; }) || null;
    },
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
      var match = g.units.find(function (u) { return u.serial && u.serial.toLowerCase() === term; });
      var first = match || (this.hasSerials ? null : g.units[0]);
      this.unitId = first ? String(first.id) : (g.units.length === 1 ? String(g.units[0].id) : '');
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

    openConfirm: function () {
      this.error = ''; this.success = '';
      if (!this.unit) { this.error = this.group ? 'Chọn số Serial của món hàng.' : 'Chọn hàng hóa từ danh sách gợi ý.'; return; }
      if (this.price === '') { this.error = 'Nhập giá bán.'; return; }
      this.confirmTime = new Date().toLocaleString('vi-VN');
      this.confirm = true;
    },
    submit: function () {
      var self = this;
      this.sending = true;
      api('/staff/sell', { method: 'POST', body: {
        item_id: this.unit.id, price: this.price, payment_method: this.payment, warranty_months: this.warranty,
        customer_name: this.customer_name, customer_phone: this.customer_phone, delivery_address: this.delivery_address,
      } }).then(function (d) {
        self.success = d.message; self.confirm = false; self.reset();
      }).catch(function (e) { self.error = e.message; self.confirm = false; })
        .finally(function () { self.sending = false; });
    },
    reset: function () {
      this.q = ''; this.results = []; this.group = null; this.unitId = ''; this.price = ''; this.payment = 'cash';
      this.customer_name = ''; this.customer_phone = ''; this.delivery_address = ''; this.warranty = '';
    },
  };
};
