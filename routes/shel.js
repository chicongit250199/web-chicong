// Bộ công cụ PowerShell cho máy khách: trong PowerShell (Admin) gõ
//   irm chicongcomputer.local/shel | iex
// → menu chọn chức năng. Script lưu ở bảng win_scripts (Hệ thống → Script Windows), mỗi script bật = 1 mục,
// gói base64 vào 1 file duy nhất; đọc lại mỗi lần tải nên thêm / sửa script là menu đổi ngay.
const router = require('express').Router();
const express = require('express');
const winScripts = require('../services/winScripts');
const pcReports = require('../services/pcReports');
const settings = require('../services/settings');

// Đuôi link bộ công cụ (mặc định "shel" → chicongcomputer.local/shel), đổi ở Hệ thống → Script Windows
const RESERVED = ['staff', 'manager', 'login', 'logout', 'test', 'uploads', 'css', 'js', 'img', 'vendor', 'c', 'p', 'api', 'favicon.ico', 'robots.txt'];
const slug = () => settings.get('shel_path') || 'shel';
function checkSlug(s) {
  const v = String(s || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(v)) throw new Error('Đuôi link chỉ gồm chữ thường không dấu, số, - và _ (2–30 ký tự)');
  if (RESERVED.includes(v)) throw new Error(`"${v}" trùng đường dẫn có sẵn của web — chọn tên khác`);
  if (require('fs').existsSync(require('path').join(__dirname, '..', 'public', v))) throw new Error(`"${v}" trùng thư mục có sẵn của web — chọn tên khác`);
  return v;
}

// chuỗi trong '...' của PowerShell (PowerShell coi cả ‘ ’ ‚ ‛ là dấu nháy đơn)
// Logo Chí Công vẽ bằng ký tự khối (2 mã / ô: nửa trên + nửa dưới; R đỏ, T xanh nhạt, B xanh dương, . trống)
// Biểu tượng sinh từ ảnh logo + chữ CHÍ CÔNG / COMPUTER bằng font điểm ảnh — PowerShell không hiện được ảnh
const LOGO_ROWS = [
  '...............R.R.RRRR.R.R.R.',
  '.........RRRRRRT.T.T.T.T.T.T.T.T.T.T.T.T.T.T.T.T.T...........................................RR..................RR.R..R',
  '.....RRRRRR.TTTTT.T.T.T.T.T.T.T.T.T.T.T.T.T.T.T.T....BBBBB.............RR.R.R...RR....RR..R.RRR........RR.R.R....RR.R..R..RR.R....RR...RR.R.R.',
  '..RRRRRRR...TTTT.................................BBBB...BB............RR........RRR.R.RR....RR........RR........RR....RR..RR..R..RRR..RR..R.RR',
  '.RRRRRRR....TTTT.........T.T.............B.BBBB.........BB............R..R.R.R..RR....RR...RRR.R......R..R.R.R..R..R.RR...RR......RR..R..R.RRR',
  'RRRRRR.R....TTTT.......TTTTTTT..........B.BBBB..........BB',
  'R.RRRRRR....TTTT...TTTT.................................BB.........RR.R.R....RR.R..R..RR.R...RRR..RRR.R..R..RR....RR..R.R.RRR.R...RRR.R.R...RRR.R..R',
  '..RRRRRR.R..TTTTTTT....................................BBB........RR........RR....RR..RR..R...RR..RR.R.RR...RR....RR......RR......RRR.R.....RR.R.RR.',
  '....R.RRRRRR.R......B.B.B.B.B.B.BBBBBBBBB.B.B.B.B.B.B.B...........R..R.R.R..R..R.RR...RR......RR..RR........R..R.RR.......RR......RR.R.R.R..RR..R..R',
  '........R.RRRRRR.R.R.R........B.B.B.B.BB',
];

const ps = (s) => String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&').replace(/[\r\n]+/g, ' ');

function build(base, src) {
  const items = winScripts.enabledWithContent().map((t) => {
    const data = Buffer.from(t.content, 'utf8').toString('base64');
    return `  @{ Key = ''; PE = $${t.pe ? 'true' : 'false'}; Name = '${ps(t.name)}'; Desc = '${ps(t.descr)}'; File = '${ps(t.file)}'; Data = '${data}' }`;
  }).join(",\n");

  return `# ==========================================================
#  BO CONG CU WINDOWS - CHI CONG COMPUTER
#  Cach dung: mo PowerShell (Admin) roi go:
#     irm ${src} | iex
#  Hoac chep file nay ra USB, chay: powershell -ExecutionPolicy Bypass -File ChiCongTools.ps1
#  (tren WinPE chi hien cac script danh dau "chay duoc tren WinPE")
# ==========================================================
& {
  Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}

  $src = '${ps(src)}'
  $env:CHICONG_WEB = '${ps(base)}'   # cac script dung de gui ket qua ve web (VD: Kiem tra cau hinh may)
  $env:CHICONG_LINK = '${ps(src)}'
  $isPE = Test-Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\MiniNT'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin -and -not $isPE) {
    Write-Host 'Đang mở lại PowerShell bằng quyền Administrator...' -ForegroundColor Yellow
    try {
      Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -Command \`"irm $src | iex\`""
    } catch {
      Write-Host '[X] Không có quyền Admin. Hãy mở PowerShell bằng Run as Administrator rồi chạy lại.' -ForegroundColor Red
    }
    return
  }

  # Logo dùng chung: menu chính + các script con gọi Show-ChiCongLogo sau Clear-Host
  function global:Show-ChiCongLogo {
    $rows = @(
${LOGO_ROWS.map(r => `      '${r}'`).join(",\n")}
    )
    $col = @{ R = 'Red'; T = 'DarkCyan'; B = 'Blue' }
    $up = [string][char]0x2580; $dn = [string][char]0x2584; $full = [string][char]0x2588
    Write-Host ''
    foreach ($row in $rows) {
      Write-Host '  ' -NoNewline
      for ($i = 0; $i -lt $row.Length; $i += 2) {
        $t = [string]$row[$i]; $b = [string]$row[$i + 1]
        if ($t -eq '.' -and $b -eq '.') { Write-Host ' ' -NoNewline }
        elseif ($t -eq '.') { Write-Host $dn -NoNewline -ForegroundColor $col[$b] }
        elseif ($b -eq '.') { Write-Host $up -NoNewline -ForegroundColor $col[$t] }
        elseif ($b -eq $t) { Write-Host $full -NoNewline -ForegroundColor $col[$t] }
        else { Write-Host $up -NoNewline -ForegroundColor $col[$t] -BackgroundColor $col[$b] }
      }
      Write-Host ''
    }
    Write-Host ''
  }

  $allTools = @(
${items}
  )
  $tools = @($allTools | Where-Object { -not $isPE -or $_.PE })
  for ($i = 0; $i -lt $tools.Count; $i++) { $tools[$i].Key = [string]($i + 1) }
  if ($tools.Count -eq 0) {
    if ($isPE) { Write-Host 'Chưa có script nào chạy được trên WinPE (Hệ thống → Script Windows → đánh dấu WinPE).' -ForegroundColor Yellow }
    else { Write-Host 'Chưa có script nào được bật (Hệ thống → Script Windows).' -ForegroundColor Yellow }
    return
  }

  $dir = Join-Path $env:TEMP 'ChiCongTools'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $utf8Bom = New-Object System.Text.UTF8Encoding $true

  while ($true) {
    Clear-Host
    Show-ChiCongLogo
    Write-Host '==========================================================' -ForegroundColor Cyan
    Write-Host '                  BỘ CÔNG CỤ WINDOWS' -ForegroundColor Yellow
    if ($isPE) { Write-Host '        (Đang chạy trên WinPE)' -ForegroundColor DarkYellow }
    Write-Host '==========================================================' -ForegroundColor Cyan
    Write-Host ''
    foreach ($t in $tools) {
      Write-Host (' [' + $t.Key + '] ') -NoNewline -ForegroundColor Green
      Write-Host $t.Name -ForegroundColor White
      if ($t.Desc) { Write-Host ('     ' + $t.Desc) -ForegroundColor DarkGray }
    }
    Write-Host ' [Q] Thoát' -ForegroundColor Red
    Write-Host ''
    $c = "$(Read-Host 'Chọn chức năng')".Trim()
    if ($c -match '^[Qq]$') { break }
    $t = $tools | Where-Object { $_.Key -eq $c } | Select-Object -First 1
    if (-not $t) { Write-Host 'Lựa chọn không hợp lệ!' -ForegroundColor Red; Start-Sleep -Seconds 1; continue }

    $p = Join-Path $dir $t.File
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($t.Data))
    [IO.File]::WriteAllText($p, $code, $utf8Bom)
    try { & $p } catch { Write-Host ('[X] Lỗi: ' + $_) -ForegroundColor Red }
    Write-Host ''
    Read-Host 'Nhấn Enter để về menu chính' | Out-Null
  }
  Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

const hostOf = (req) => String(req.headers.host || 'chicongcomputer.local').replace(/[^A-Za-z0-9.:\-]/g, '') || 'chicongcomputer.local';

// ?download=1 → tải về file ChiCongTools.ps1 (có BOM để PowerShell 5.1 đọc đúng tiếng Việt) — chép ra USB chạy trên WinPE / máy không mạng
router.get('/:slug', (req, res, next) => {
  const s = slug();
  if (req.params.slug !== s && !(s === 'shel' && req.params.slug === 'shell')) return next();
  try {
    const base = `http://${hostOf(req)}`;
    const body = build(base, `${base}/${s}`);
    res.set('Cache-Control', 'no-store');
    if (req.query.download) {
      res.attachment('ChiCongTools.ps1');
      return res.type('application/octet-stream').send(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]));
    }
    res.type('text/plain; charset=utf-8').send(body);
  } catch (e) { next(e); }
});

// Script "Kiểm tra cấu hình máy" gửi kết quả lên (không cần đăng nhập — chỉ máy trong LAN vào được)
router.post('/shel/report', express.json({ limit: '512kb' }), (req, res) => {
  try {
    const r = pcReports.add(req.body, req.ip);
    res.json({ ok: true, id: r.id, model: r.model });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Trang test phần cứng (bàn phím, màn hình, loa, mic, webcam, chuột) — script "Test phần cứng" mở trang này
router.get('/test', (req, res) => res.render('hwtest', { logo: require('../services/settings').get('logo_url') || '' }));

module.exports = router;
module.exports.slug = slug;
module.exports.checkSlug = checkSlug;
