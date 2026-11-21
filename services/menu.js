'use strict';
// Menu chức năng. key dùng để đánh dấu mục đang mở (res.locals.nav)
const staff = [
  { key: 'home', href: '/staff', icon: 'home', label: 'Tổng quan' },
  { key: 'task-new', href: '/staff/tasks/new', icon: 'inbox', label: 'Nhận máy' },
  { key: 'tasks-pending', href: '/staff/tasks?view=pending', icon: 'list', label: 'Task chưa làm', badge: 'pending' },
  { key: 'tasks-assigned', href: '/staff/tasks?view=assigned', icon: 'userCheck', label: 'Task được giao', badge: 'assigned' },
  { key: 'tasks-processing', href: '/staff/tasks?view=processing', icon: 'wrench', label: 'Task đang làm', badge: 'processing' },
  { key: 'return', href: '/staff/return', icon: 'checkCircle', label: 'Trả máy', badge: 'ready' },
  { key: 'completed', href: '/staff/tasks?view=completed', icon: 'checkSquare', label: 'Máy đã trả' },
  { key: 'sell', href: '/staff/sell', icon: 'cart', label: 'Bán hàng' },
  { key: 'search', href: '/staff/search', icon: 'search', label: 'Tìm kiếm' },
  { key: 'inventory', href: '/staff/inventory', icon: 'archive', label: 'Xem kho' },
  { key: 'inventory-new', href: '/staff/inventory/new', icon: 'plusSquare', label: 'Nhập kho' },
  { key: 'product-new', href: '/staff/products/new', icon: 'upload', label: 'Đăng sản phẩm' },
];

const manager = [
  { key: 'm-home', href: '/manager', icon: 'chart', label: 'Doanh thu hôm nay' },
  { key: 'm-revenue', href: '/manager/revenue', icon: 'trending', label: 'Thống kê doanh thu' },
  { key: 'm-assign', href: '/manager/assign', icon: 'userCheck', label: 'Phân task', badge: 'unassigned' },
  { key: 'm-products', href: '/manager/products', icon: 'checkSquare', label: 'Duyệt sản phẩm', badge: 'productsPending' },
  { key: 'm-homepage', href: '/manager/homepage', icon: 'settings', label: 'Sửa trang chủ' },
  { key: 'm-users', href: '/manager/users', icon: 'users', label: 'Tài khoản nhân viên' },
  { key: 'm-import', href: '/manager/import', icon: 'fileSheet', label: 'Import Excel kho' },
  { key: 'm-vat', href: '/manager/vat', icon: 'receipt', label: 'Kho hóa đơn VAT' },
  { key: 'm-system', href: '/manager/system', icon: 'cpu', label: 'Hệ thống' },
];

module.exports = { staff, manager };
