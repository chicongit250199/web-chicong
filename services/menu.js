'use strict';
// Menu chức năng, chia nhóm theo nghiệp vụ. key dùng để đánh dấu mục đang mở (res.locals.nav).
// roles: ai thấy mục đó ('staff' = nhân viên, 'manager' = quản lý). Quản lý có toàn quyền nghiệp vụ của nhân viên.
const GROUPS = [
  {
    title: 'Tổng quan',
    items: [
      { key: 'm-home', also: ['m-revenue', 'm-debts'], href: '/manager', icon: 'chart', label: 'Doanh thu', roles: ['manager'] },
      { key: 'm-expenses', href: '/manager/expenses', icon: 'cash', label: 'Chi phí', roles: ['manager'] },
      { key: 'home', href: '/staff', icon: 'home', label: 'Bảng công việc', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Sửa chữa',
    items: [
      // Nhận - Trả: tab Nhận máy / Trả máy
      { key: 'm-intake', also: ['task-new', 'return'], href: '/staff/tasks/new', icon: 'inbox', label: 'Nhận - Trả', badge: 'ready', roles: ['staff', 'manager'] },
      // 1 mục gồm các tab Chưa làm / Được giao / Đang làm / Quá hạn / Chờ trả / Đã trả / Tất cả (+ Phân task cho quản lý)
      { key: 'm-tasks', href: '/staff/tasks?view=pending', icon: 'list', label: 'Quản lý task', badge: 'taskMenu', roles: ['staff', 'manager'] },
      { key: 'partners', href: '/staff/partners', icon: 'users', label: 'Khách đối tác', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Bán hàng & Kho',
    items: [
      { key: 'sell', href: '/staff/sell', icon: 'cart', label: 'Bán hàng / Dịch vụ', roles: ['staff', 'manager'] },
      // 1 mục gồm tab Tồn kho / Đã bán / Nhập kho / Tra cứu bảo hành (also: các trang con vẫn sáng mục này)
      { key: 'm-inventory', also: ['inventory', 'inventory-new', 'search', 'ic'], href: '/staff/inventory', icon: 'archive', label: 'Quản lý kho', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Build PC',
    items: [
      // 1 mục Build PC + Giá Linh Kiện (2 trang có nút qua lại; nhân viên xem giá ở /staff/pc-parts)
      { key: 'm-build', also: ['build', 'm-pc-parts', 'pc-parts-view'], href: '/staff/build', icon: 'desktop', label: 'Build PC - Giá Linh Kiện', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Tiện ích',
    items: [
      { key: 'print', href: '/staff/print', icon: 'printer', label: 'In tài liệu', kw: 'in phieu gui hang in file may in', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Hóa đơn VAT',
    items: [
      { key: 'm-vat', href: '/manager/vat', icon: 'receipt', label: 'Kho hóa đơn VAT', roles: ['manager'] },
    ],
  },
  {
    title: 'Website',
    items: [
      { key: 'product-new', href: '/staff/products/new', icon: 'upload', label: 'Đăng sản phẩm', roles: ['staff'] },
      // Quản lý: 1 mục gồm danh sách sửa (mặc định), Chờ duyệt, nút Đăng sản phẩm
      { key: 'm-products', href: '/manager/products', icon: 'upload', label: 'Quản lý sản phẩm', badge: 'productsPending', roles: ['manager'] },
    ],
  },
  {
    title: 'Quản trị',
    items: [
      { key: 'm-system', also: ['m-users', 'm-import'], href: '/manager/system', icon: 'cpu', label: 'Hệ thống', roles: ['manager'] },
    ],
  },
];

// Trang con (tab) — chỉ hiện khi gõ tìm ở ô "Tìm chức năng" đầu menu. kw: từ khóa thêm (không dấu)
const EXTRAS = [
  { label: 'Nhận máy', parent: 'Nhận - Trả', href: '/staff/tasks/new', icon: 'inbox', kw: 'phieu nhan may tiep nhan', roles: ['staff', 'manager'] },
  { label: 'Trả máy', parent: 'Nhận - Trả', href: '/staff/return', icon: 'checkCircle', kw: 'giao may tra khach', roles: ['staff', 'manager'] },
  { label: 'Task quá hạn', parent: 'Quản lý task', href: '/staff/tasks?view=overdue', icon: 'alert', kw: 'qua han tre', roles: ['staff', 'manager'] },
  { label: 'Task đang làm', parent: 'Quản lý task', href: '/staff/tasks?view=processing', icon: 'wrench', kw: 'dang sua', roles: ['staff', 'manager'] },
  { label: 'Máy đã trả', parent: 'Quản lý task', href: '/staff/tasks?view=completed', icon: 'checkCircle', kw: 'da tra lich su', roles: ['staff', 'manager'] },
  { label: 'Phân task', parent: 'Quản lý task', href: '/manager/assign', icon: 'userCheck', kw: 'giao viec phan cong', roles: ['manager'] },
  { label: 'Nhập kho', parent: 'Quản lý kho', href: '/staff/inventory/new', icon: 'plusSquare', kw: 'them hang nhap hang', roles: ['staff', 'manager'] },
  { label: 'Hàng đã bán', parent: 'Quản lý kho', href: '/staff/inventory?tab=sold', icon: 'archive', kw: 'da ban', roles: ['staff', 'manager'] },
  { label: 'IC sửa chữa', parent: 'Quản lý kho', href: '/staff/ic', icon: 'cpu', kw: 'ic chip linh kien', roles: ['staff', 'manager'] },
  { label: 'Tra cứu IC', parent: 'Quản lý kho', href: '/staff/ic/lookup', icon: 'search', kw: 'ic datasheet tuong duong ky hieu', roles: ['staff', 'manager'] },
  { label: 'Tra cứu bảo hành', parent: 'Quản lý kho', href: '/staff/search', icon: 'search', kw: 'bao hanh serial', roles: ['staff', 'manager'] },
  { label: 'Thống kê doanh thu', parent: 'Doanh thu', href: '/manager/revenue', icon: 'chart', kw: 'thong ke bao cao', roles: ['manager'] },
  { label: 'Chi phí', parent: 'Doanh thu', href: '/manager/expenses', icon: 'cash', kw: 'chi phi chi tieu', roles: ['manager'] },
  { label: 'Công nợ', parent: 'Doanh thu', href: '/manager/debts', icon: 'bank', kw: 'no cong no', roles: ['manager'] },
  { label: 'Sản phẩm chờ duyệt', parent: 'Quản lý sản phẩm', href: '/manager/products?tab=pending', icon: 'upload', kw: 'duyet', roles: ['manager'] },
  { label: 'Trang chủ website', parent: 'Quản lý sản phẩm', href: '/manager/homepage', icon: 'home', kw: 'website trang chu', roles: ['manager'] },
  { label: 'Máy in & phiếu', parent: 'Hệ thống', href: '/manager/system?tab=printers', icon: 'printer', kw: 'may in phieu', roles: ['manager'] },
  { label: 'Cài đặt', parent: 'Hệ thống', href: '/manager/system?tab=settings', icon: 'settings', kw: 'cai dat qr google sheet email bao cao', roles: ['manager'] },
  { label: 'Script Windows', parent: 'Hệ thống', href: '/manager/system/scripts', icon: 'terminal', kw: 'powershell script shel cai win', roles: ['manager'] },
  { label: 'Sao lưu', parent: 'Hệ thống', href: '/manager/system?tab=backup', icon: 'lock', kw: 'sao luu backup', roles: ['manager'] },
  { label: 'Import Excel', parent: 'Hệ thống', href: '/manager/import', icon: 'fileSheet', kw: 'import excel nhap file', roles: ['manager'] },
  { label: 'Nhân viên - Zalo', parent: 'Hệ thống', href: '/manager/users', icon: 'key', kw: 'nhan vien tai khoan zalo bot', roles: ['manager'] },
];

// Nhóm menu theo vai trò (bỏ nhóm rỗng)
const cache = {};
function groupsFor(role) {
  if (!cache[role]) cache[role] = GROUPS.map(g => ({ title: g.title, items: g.items.filter(i => i.roles.includes(role)) })).filter(g => g.items.length);
  return cache[role];
}

const extrasFor = (role) => EXTRAS.filter(i => i.roles.includes(role));

module.exports = { groupsFor, extrasFor };
