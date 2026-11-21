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

  window.formatVnd = function (n) {
    if (n === null || n === undefined || n === '') return '';
    return new Intl.NumberFormat('vi-VN').format(Number(String(n).replace(/[^\d-]/g, '')) || 0);
  };
})();
