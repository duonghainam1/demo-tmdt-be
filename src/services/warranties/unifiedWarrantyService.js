// services/warranties/unifiedWarrantyService.js
// Gộp bảo hành SẢN PHẨM ĐÃ BÁN (từ đơn hàng) + bảo hành SAU SỬA CHỮA vào cùng 1 danh sách.
// Mỗi phần tử có type: 'product' | 'repair' và cùng bộ trường ngày tháng / trạng thái.
import Orders from '../../models/orders/ordersModel.js';
import RepairRequest from '../../models/repairr/repairrequestMode.js';
import { HttpError } from '../../utils/httpError.js';
import { buildWarranties } from './warrantyLookupService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_CODE_RE = /^NX\d{6}[A-Z0-9]{6}$/i; // mã đơn hàng, vd NX261102AB12CD
const REPAIR_CODE_RE = /^SC-\d{8}-\d{4,}$/i; // mã đơn sửa chữa / tem QR

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizePhone = (p) => String(p || '').replace(/[\s.-]/g, '').replace(/^\+84/, '0').replace(/^84(?=\d{9}$)/, '0');
const phoneVariants = (local) => [local, `+84${local.slice(1)}`, `84${local.slice(1)}`];
const maskSerial = (s) => (s ? `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : '');

// Chấp nhận mã thường, IMEI/Serial, hoặc cả đường dẫn khi quét QR
const extractCode = (raw) => {
  let s = String(raw || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.searchParams.get('code') || u.searchParams.get('c') || u.pathname.split('/').filter(Boolean).pop() || '';
    } catch {
      return '';
    }
  }
  s = s.trim();
  return /^[A-Za-z0-9-]{6,40}$/.test(s) ? s : '';
};

/* ------------------------------ chuyển về cùng 1 dạng ------------------------------ */
const productItem = (w) => ({
  type: 'product',
  code: w.orderCode, // mã đơn hàng
  name: w.name,
  image: w.image,
  sku: w.sku,
  attributes: w.attributes,
  quantity: w.quantity,
  serial: '',
  warrantyMonths: w.warrantyMonths,
  startDate: w.startDate,
  endDate: w.endDate,
  status: w.status,
  remainingDays: w.remainingDays,
  diagnosis: '', // sản phẩm đã bán không có chẩn đoán / cách xử lý
  solution: '',
});

const repairItem = (r, now) => {
  const endDate = new Date(r.warrantyExpiresAt);
  const active = endDate >= now;
  return {
    type: 'repair',
    code: r.requestCode, // mã đơn sửa chữa (cũng là mã tem QR)
    name: r.title || r.device,
    image: '',
    sku: '',
    attributes: [],
    quantity: 1,
    serial: maskSerial(r.serialNumber),
    warrantyMonths: r.warrantyMonths,
    startDate: r.completedAt,
    endDate,
    status: active ? 'active' : 'expired',
    remainingDays: active ? Math.ceil((endDate - now) / DAY_MS) : 0,
    diagnosis: r.diagnosis || '', // chẩn đoán
    solution: r.solution || '', // cách xử lý
  };
};

// Còn bảo hành lên trước (sắp hết hạn trước), hết hạn xuống cuối
const merge = (products, repairs) => {
  const now = new Date();
  const data = [...products.map(productItem), ...repairs.filter((r) => r.warrantyExpiresAt).map((r) => repairItem(r, now))];
  data.sort((a, b) => (a.status !== b.status ? (a.status === 'active' ? -1 : 1) : new Date(a.endDate) - new Date(b.endDate)));

  const active = data.filter((d) => d.status === 'active').length;
  return { data, summary: { total: data.length, active, expired: data.length - active } };
};

const REPAIR_SELECT =
  'requestCode title device serialNumber completedAt warrantyMonths warrantyExpiresAt diagnosis solution';
const ORDER_SELECT = 'code items statusHistory createdAt updatedAt';

/* ------------------------------ tra cứu công khai ------------------------------ */
/**
 * GET /warranty?code=&phone=
 *   code = mã đơn hàng (NX...)     -> BẮT BUỘC kèm phone (SĐT người nhận), trả bảo hành sản phẩm của đơn đó
 *   code = mã sửa chữa (SC-...) hoặc IMEI/Serial -> trả bảo hành sửa chữa (phone là tùy chọn, nếu có phải khớp)
 *   chỉ có phone                   -> trả tất cả bảo hành (sản phẩm + sửa chữa) gắn với SĐT đó
 */
export const lookupAllWarranties = async ({ code: rawCode, phone: rawPhone } = {}) => {
  const phone = normalizePhone(rawPhone);
  if (phone && !/^0\d{9}$/.test(phone)) throw new HttpError(400, 'Số điện thoại không hợp lệ', 'INVALID_PHONE');

  const hasCodeInput = String(rawCode || '').trim() !== '';
  const code = extractCode(rawCode);
  if (hasCodeInput && !code) {
    throw new HttpError(400, 'Mã tra cứu không hợp lệ (mã đơn hàng, mã sửa chữa, IMEI hoặc Serial)', 'INVALID_CODE');
  }
  if (!code && !phone) {
    throw new HttpError(400, 'Vui lòng nhập mã đơn / mã sửa chữa / IMEI / Serial hoặc số điện thoại', 'LOOKUP_REQUIRED');
  }

  let orders = [];
  let repairs = [];

  if (code && ORDER_CODE_RE.test(code)) {
    // Mã đơn hàng: bắt buộc SĐT để tránh dò mã
    if (!phone) throw new HttpError(400, 'Vui lòng nhập số điện thoại nhận hàng của đơn này', 'PHONE_REQUIRED');
    orders = await Orders.find({
      code: code.toUpperCase(),
      status: 'completed',
      'shippingAddress.phone': { $in: phoneVariants(phone) },
    })
      .select(ORDER_SELECT)
      .lean();
  } else if (code) {
    const filter = { status: 'completed', warrantyExpiresAt: { $ne: null } };
    if (REPAIR_CODE_RE.test(code)) filter.requestCode = code.toUpperCase();
    else filter.serialNumber = new RegExp(`^${escapeRegex(code)}$`, 'i');
    if (phone) filter.phone = { $in: phoneVariants(phone) };
    repairs = await RepairRequest.find(filter).select(REPAIR_SELECT).sort({ completedAt: -1 }).limit(10).lean();
  } else {
    // Chỉ có SĐT: lấy cả 2 loại
    const variants = phoneVariants(phone);
    [orders, repairs] = await Promise.all([
      Orders.find({ status: 'completed', 'shippingAddress.phone': { $in: variants } })
        .select(ORDER_SELECT)
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      RepairRequest.find({ status: 'completed', warrantyExpiresAt: { $ne: null }, phone: { $in: variants } })
        .select(REPAIR_SELECT)
        .sort({ completedAt: -1 })
        .limit(50)
        .lean(),
    ]);
  }

  const products = orders.length ? await buildWarranties(orders) : [];
  const result = merge(products, repairs);

  // Cùng 1 thông báo cho "sai mã" và "sai SĐT" để không lộ đơn nào tồn tại
  if (!result.data.length) {
    throw new HttpError(404, 'Không tìm thấy thông tin bảo hành cho thông tin này', 'WARRANTY_NOT_FOUND');
  }
  return result;
};

/* ------------------------------ của tôi (đã đăng nhập) ------------------------------ */
/** GET /warranty/my : toàn bộ bảo hành sản phẩm + sửa chữa của tài khoản. */
export const getMyAllWarranties = async (userId) => {
  const [orders, repairs] = await Promise.all([
    Orders.find({ user: userId, status: 'completed' }).select(ORDER_SELECT).sort({ createdAt: -1 }).limit(200).lean(),
    RepairRequest.find({ customer: userId, status: 'completed', warrantyExpiresAt: { $ne: null } })
      .select(REPAIR_SELECT)
      .sort({ completedAt: -1 })
      .limit(200)
      .lean(),
  ]);
  const products = orders.length ? await buildWarranties(orders) : [];
  return merge(products, repairs);
};