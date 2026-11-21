'use strict';
// Menu chức năng, chia nhóm theo nghiệp vụ. key dùng để đánh dấu mục đang mở (res.locals.nav).
// roles: ai thấy mục đó ('staff' = nhân viên, 'manager' = quản lý). Quản lý có toàn quyền nghiệp vụ của nhân viên.
const GROUPS = [
  {
    title: 'Tổng quan',
    items: [
      { key: 'm-home', href: '/manager', icon: 'chart', label: 'Doanh thu hôm nay', roles: ['manager'] },
      { key: 'm-revenue', href: '/manager/revenue', icon: 'trending', label: 'Thống kê doanh thu', roles: ['manager'] },
      { key: 'm-expenses', href: '/manager/expenses', icon: 'cash', label: 'Chi phí', roles: ['manager'] },
      { key: 'home', href: '/staff', icon: 'home', label: 'Bảng công việc', roles: ['staff', 'manager'] },
    ],
  },
  {
    title: 'Sửa chữa',
    items: [
      { key: 'task-new', href: '/staff/tasks/new', icon: 'inbox', label: 'Nhận máy', roles: ['staff', 'manager'] },
      { key: 'tasks-pending', href: '/staff/tasks?view=pending', icon: 'list', label: 'Task chưa làm', badge: 'pending', roles: ['staff', 'manager'] },
      { key: 'tasks-assigned', href: '/staff/tasks?view=assigned', icon: 'userCheck', label: 'Task được giao', badge: 'assigned', roles: ['staff', 'manager'] },
      { key: 'tasks-processing', href: '/staff/tasks?view=processing', icon: 'wrench', label: 'Task đang làm', badge: 'processing', roles: ['staff', 'manager'] },
      { key: 'return', href: '/staff/return', icon: 'checkCircle', label: 'Trả máy', badge: 'ready', roles: ['staff', 'manager'] },
      { key: 'completed', href: '/staff/tasks?view=completed', icon: 'checkSquare', label: 'Máy đã trả', roles: ['staff', 'manager'] },
      { key: 'm-assign', href: '/manager/assign', icon: 'users', label: 'Phân task', badge: 'unassigned', roles: ['manager'] },
    ],
  },
  {
    title: 'Bán hàng & Kho',
    items: [
      { key: 'sell', href: '/staff/sell', icon: 'cart', label: 'Bán hàng / Dịch vụ', roles: ['staff', 'manager'] },
      { key: 'inventory', href: '/staff/inventory', icon: 'archive', label: 'Xem kho', roles: ['staff', 'manager'] },
      { key: 'inventory-new', href: '/staff/inventory/new', icon: 'plusSquare', label: 'Nhập kho', roles: ['staff', 'manager'] },
      { key: 'search', href: '/staff/search', icon: 'search', label: 'Tra cứu bảo hành', roles: ['staff', 'manager'] },
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
      { key: 'product-new', href: '/staff/products/new', icon: 'upload', label: 'Đăng sản phẩm', roles: ['staff', 'manager'] },
      { key: 'm-products', href: '/manager/products', icon: 'checkSquare', label: 'Duyệt sản phẩm', badge: 'productsPending', roles: ['manager'] },
      { key: 'm-homepage', href: '/manager/homepage', icon: 'settings', label: 'Sửa trang chủ', roles: ['manager'] },
    ],
  },
  {
    title: 'Quản trị',
    items: [
      { key: 'm-import', href: '/manager/import', icon: 'fileSheet', label: 'Import Excel', roles: ['manager'] },
      { key: 'm-users', href: '/manager/users', icon: 'key', label: 'Tài khoản nhân viên', roles: ['manager'] },
      { key: 'm-system', href: '/manager/system', icon: 'cpu', label: 'Hệ thống', roles: ['manager'] },
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
