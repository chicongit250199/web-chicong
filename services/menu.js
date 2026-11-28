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
      { key: 'print', href: '/staff/print', icon: 'printer', label: 'In tài liệu', roles: ['staff', 'manager'] },
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

// Nhóm menu theo vai trò (bỏ nhóm rỗng)
const cache = {};
function groupsFor(role) {
  if (!cache[role]) cache[role] = GROUPS.map(g => ({ title: g.title, items: g.items.filter(i => i.roles.includes(role)) })).filter(g => g.items.length);
  return cache[role];
}

module.exports = { groupsFor };
