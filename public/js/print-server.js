// Nút "In ra máy in cửa hàng" trên trang phiếu: gửi yêu cầu cho server in ra máy in NUC
(function () {
  var btn = document.getElementById('print-server-btn');
  if (!btn) return;
  var msg = document.getElementById('print-server-msg');
  var copies = document.getElementById('print-server-copies');
  var label = btn.textContent;
  btn.addEventListener('click', function () {
    btn.disabled = true; btn.textContent = 'Đang gửi lệnh in...'; msg.textContent = ''; msg.style.color = '';
    fetch('/staff/print/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content },
      body: JSON.stringify({ path: location.pathname + location.search, title: document.title, copies: copies ? copies.value : 1 }),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ('Lỗi ' + r.status)); return d; }); })
      .then(function (d) { msg.style.color = '#047857'; msg.textContent = '✓ Đã gửi ra máy in ' + d.printer + '.'; })
      .catch(function (e) { msg.style.color = '#b91c1c'; msg.textContent = '✗ ' + e.message; alert(e.message); })
      .finally(function () { btn.disabled = false; btn.textContent = label; });
  });
})();
