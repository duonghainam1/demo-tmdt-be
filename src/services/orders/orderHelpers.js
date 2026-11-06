import mongoose from 'mongoose';
import Orders, { PAYMENT_METHODS, PAYMENT_STATUSES, ORDER_STATUSES } from '../../models/orders/ordersModel.js';
import Inventory from '../../models/inventory/inventoryModel.js';
import Products from '../../models/products/productModel.js';
import InventoryTransactions from '../../models/inventory/inventoryTransactionModel.js'; // chỉnh đường dẫn cho đúng dự án
import { HttpError } from '../../utils/httpError.js';
import {
  reserveQuota,
  releaseQuotaByOrder,
  completePurchasesByOrder,
} from '../flashSales/flashSaleService.js'; // chỉnh đường dẫn cho đúng dự án
import { refundVoucher, markVoucherUsed } from '../voucher/voucherService.js';

/* Phần dùng chung cho đơn hàng phía khách và phía admin */

export { PAYMENT_STATUSES };

/* ------------------------------ tiện ích nhỏ ------------------------------ */
export const clean = (v) => (typeof v === 'string' ? v.trim() : '');

export const toOrderCode = (code) => String(code).toUpperCase();

export const orderNotFound = () => new HttpError(404, 'Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND');

// Một dòng lịch sử trạng thái (dùng cho $push vào statusHistory)
export const historyEntry = (status, note, changedBy) => ({ status, note, changedBy });

// Ném 404 nếu không có đơn nào mang mã này (dùng khi cần phân biệt "không có đơn" với "sai trạng thái")
export const assertOrderExists = async (code) => {
  const exists = await Orders.exists({ code: toOrderCode(code) });
  if (!exists) throw orderNotFound();
};

/**
 * Tìm 1 đơn theo mã (lean), không thấy thì ném 404.
 *   user:     chỉ tìm trong đơn của user này (phía khách)
 *   populate: [path, select] (phía admin, vd ['user', 'fullName email'])
 */
export const findOrderByCode = async (code, { user, populate } = {}) => {
  const filter = { code: toOrderCode(code) };
  if (user) filter.user = user;

  const query = Orders.findOne(filter);
  if (populate) query.populate(...populate);

  const order = await query.lean();
  if (!order) throw orderNotFound();
  return order;
};

/**
 * Chạy fn(session) trong 1 transaction và trả về kết quả của fn.
 * Tự đóng session dù thành công hay lỗi.
 */
export const runInTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

/* ------------------------------ lọc theo kỳ (ngày/tuần/tháng/quý/năm) ------------------------------ */
// Tính theo giờ Việt Nam (UTC+7) để "hôm nay" / "tháng này" khớp với cửa hàng
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = ['day', 'week', 'month', 'quarter', 'year'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// 00:00 giờ VN của ngày (y, m, d); Date.UTC tự xử lý tràn tháng/ngày (m = 12 -> tháng 1 năm sau)
const vnMidnight = (y, m, d) => new Date(Date.UTC(y, m, d) - VN_OFFSET_MS);

// Nhận YYYY | YYYY-MM | YYYY-MM-DD | ISO. 3 dạng đầu trả về mốc 00:00 giờ VN
const parseDate = (value, field) => {
  const s = String(value).trim();
  let m;
  let d;
  if ((m = /^(\d{4})$/.exec(s))) d = vnMidnight(+m[1], 0, 1);
  else if ((m = /^(\d{4})-(\d{2})$/.exec(s))) d = vnMidnight(+m[1], +m[2] - 1, 1);
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) d = vnMidnight(+m[1], +m[2] - 1, +m[3]);
  else d = new Date(s);

  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, `Ngày "${field}" không hợp lệ`, 'INVALID_DATE');
  }
  return d;
};

/**
 * Khoảng [start, end) của kỳ chứa mốc `ref`. Tuần bắt đầu từ thứ 2.
 */
const getPeriodRange = (period, ref) => {
  const v = new Date(ref.getTime() + VN_OFFSET_MS); // đọc ngày/tháng/năm theo giờ VN
  const y = v.getUTCFullYear();
  const mo = v.getUTCMonth();
  const d = v.getUTCDate();

  switch (period) {
    case 'day':
      return { start: vnMidnight(y, mo, d), end: vnMidnight(y, mo, d + 1) };
    case 'week': {
      const back = (v.getUTCDay() + 6) % 7; // thứ 2 = 0 ... chủ nhật = 6
      return { start: vnMidnight(y, mo, d - back), end: vnMidnight(y, mo, d - back + 7) };
    }
    case 'month':
      return { start: vnMidnight(y, mo, 1), end: vnMidnight(y, mo + 1, 1) };
    case 'quarter': {
      const qStart = Math.floor(mo / 3) * 3;
      return { start: vnMidnight(y, qStart, 1), end: vnMidnight(y, qStart + 3, 1) };
    }
    default: // year
      return { start: vnMidnight(y, 0, 1), end: vnMidnight(y + 1, 0, 1) };
  }
};

/* ------------------------------ tiền cần thu / đã thu ------------------------------ */
/**
 * Quy tắc tính (chỉnh ở đây là đổi cả cột từng dòng lẫn dòng tổng). Tính RÒNG sau khi hoàn tiền:
 *   - Chỉ đơn còn "hiệu lực bán hàng" mới tính: pending, confirmed, shipping, completed.
 *     Đơn cancelled / returning / returned thì cả 2 cột = 0 (hàng không bán được).
 *   - net       = max(0, total - refundedAmount)   (refundedAmount = tiền đã hoàn do khách trả hàng)
 *   - toCollect (cần thu) = net
 *   - collected (đã thu)  = net nếu paymentStatus là paid | partially_refunded | refunded, ngược lại 0
 *   Vd đơn 2.200.000đ: hoàn toàn bộ -> 0 / 0; hoàn 1.000.000đ -> 1.200.000 / 1.200.000.
 *   Phí ship không nằm trong refundedAmount (xem calcRefundAmount) nên nếu đơn có phí ship thì phần đó vẫn tính là đã thu.
 */
export const AMOUNT_ORDER_STATUSES = ['pending', 'confirmed', 'shipping', 'completed'];
export const AMOUNT_PAID_STATUSES = ['paid', 'partially_refunded', 'refunded'];

// Tiền cần thu / đã thu của 1 đơn (lean object). refunded = tiền đã hoàn cho khách.
export const orderAmounts = (o) => {
  const counted = AMOUNT_ORDER_STATUSES.includes(o.status);
  const net = Math.max(0, (o.total || 0) - (o.refundedAmount || 0));
  return {
    toCollect: counted ? net : 0,
    collected: counted && AMOUNT_PAID_STATUSES.includes(o.paymentStatus) ? net : 0,
    refunded: o.refundedAmount || 0,
  };
};

// Biểu thức Mongo cho "tiền ròng" của 1 đơn (cùng quy tắc với orderAmounts)
const NET_EXPR = { $max: [0, { $subtract: ['$total', { $ifNull: ['$refundedAmount', 0] }] }] };

// Stage $group tính tổng 3 cột trên nhiều đơn (cùng quy tắc với orderAmounts)
const AMOUNT_TOTALS_STAGE = {
  $group: {
    _id: null,
    toCollect: { $sum: { $cond: [{ $in: ['$status', AMOUNT_ORDER_STATUSES] }, NET_EXPR, 0] } },
    collected: {
      $sum: {
        $cond: [
          { $and: [{ $in: ['$status', AMOUNT_ORDER_STATUSES] }, { $in: ['$paymentStatus', AMOUNT_PAID_STATUSES] }] },
          NET_EXPR,
          0,
        ],
      },
    },
    refunded: { $sum: { $ifNull: ['$refundedAmount', 0] } },
  },
};

/* ------------------------------ danh sách đơn ------------------------------ */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  total_desc: { total: -1, _id: -1 },
  total_asc: { total: 1, _id: 1 },
};

const RETURN_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'completed'];

/**
 * Danh sách đơn hàng có tìm kiếm + lọc + phân trang (khách và admin dùng chung).
 * `baseFilter` là điều kiện bắt buộc: khách truyền { user }, admin truyền {}.
 *
 * Query hỗ trợ:
 *   q              mã đơn, tên sản phẩm, tên hoặc SĐT người nhận
 *   status         pending | confirmed | shipping | completed | returning | returned | cancelled | all (mặc định all)
 *   paymentMethod  cod | bank_transfer
 *   paymentStatus  unpaid | paid | partially_refunded | refunded
 *   period         day | week | month | quarter | year (lọc theo kỳ, tính theo giờ VN, tuần bắt đầu thứ 2)
 *   date           mốc của kỳ: YYYY-MM-DD | YYYY-MM | YYYY (mặc định hôm nay), chỉ dùng cùng period
 *   from, to       lọc khoảng tùy chọn theo ngày đặt (dùng khi không có period); "to" tính hết ngày
 *   cancelRequest  pending = chỉ đơn có yêu cầu hủy đang chờ admin duyệt
 *   returnRequest  pending | approved | rejected | completed = lọc theo trạng thái yêu cầu trả hàng
 *   sort           newest (mặc định) | oldest | total_desc | total_asc
 *   page, limit    mặc định 1 và 10, limit tối đa 50
 *
 * Trả về { items, pagination, counts, range, totals }.
 * Mỗi item có thêm toCollect / collected / refunded (xem orderAmounts). totals = { toCollect, collected, refunded } cộng trên TẤT CẢ
 * đơn khớp bộ lọc (kể cả status), không chỉ trang hiện tại.
 * counts đã áp dụng mọi bộ lọc TRỪ status,
 * nên đổi tab số vẫn không nhảy. range = { start, end } (end là mốc loại trừ), null nếu không lọc ngày.
 */
export const listOrders = async (baseFilter, query = {}, { select = '-__v' } = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 50);

  const status = clean(query.status) || 'all';
  if (status !== 'all' && !ORDER_STATUSES.includes(status)) {
    throw new HttpError(400, 'Trạng thái đơn hàng không hợp lệ', 'INVALID_STATUS');
  }

  const paymentMethod = clean(query.paymentMethod);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new HttpError(400, 'Phương thức thanh toán không hợp lệ', 'INVALID_PAYMENT_METHOD');
  }

  const paymentStatus = clean(query.paymentStatus);
  if (paymentStatus && !PAYMENT_STATUSES.includes(paymentStatus)) {
    throw new HttpError(400, 'Trạng thái thanh toán không hợp lệ', 'INVALID_PAYMENT_STATUS');
  }

  const base = { ...baseFilter };
  if (paymentMethod) base.paymentMethod = paymentMethod;
  if (paymentStatus) base.paymentStatus = paymentStatus;

  // Lọc theo ngày đặt: ưu tiên `period` (+ `date`), không có thì dùng from/to
  const period = clean(query.period);
  if (period && !PERIODS.includes(period)) {
    throw new HttpError(400, 'Kỳ lọc không hợp lệ (day, week, month, quarter, year)', 'INVALID_PERIOD');
  }

  let range = null;
  if (period) {
    const ref = clean(query.date) ? parseDate(query.date, 'date') : new Date();
    range = getPeriodRange(period, ref);
    base.createdAt = { $gte: range.start, $lt: range.end };
  } else {
    const createdAt = {};
    let start = null;
    let end = null;

    if (query.from) {
      start = parseDate(query.from, 'from');
      createdAt.$gte = start;
    }
    if (query.to) {
      end = parseDate(query.to, 'to');
      // Dạng ngày (YYYY, YYYY-MM, YYYY-MM-DD) -> tính hết ngày đó (giờ VN)
      if (DATE_ONLY.test(String(query.to).trim())) end = new Date(end.getTime() + DAY_MS);
      createdAt.$lt = end;
    }
    if (start || end) {
      base.createdAt = createdAt;
      range = { start, end };
    }
  }

  const q = clean(query.q).slice(0, 100);
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    base.$or = [
      { code: re },
      { 'items.name': re },
      { 'shippingAddress.fullName': re },
      { 'shippingAddress.phone': re },
    ];
  }

  // Điều kiện của danh sách (khác base: có thêm status, cancelRequest, returnRequest)
  const filter = { ...base };
  if (status !== 'all') filter.status = status;
  if (clean(query.cancelRequest) === 'pending') filter['cancelRequest.status'] = 'pending';

  // [TRẢ HÀNG]
  const returnStatus = clean(query.returnRequest);
  if (RETURN_REQUEST_STATUSES.includes(returnStatus)) filter['returnRequest.status'] = returnStatus;

  const [items, total, grouped, cancelRequested, returnRequested, amountAgg] = await Promise.all([
    Orders.find(filter)
      .select(select)
      .sort(SORTS[query.sort] || SORTS.newest)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Orders.countDocuments(filter),
    Orders.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Orders.countDocuments({ ...base, 'cancelRequest.status': 'pending' }),
    Orders.countDocuments({ ...base, 'returnRequest.status': 'pending' }), // [TRẢ HÀNG]
    Orders.aggregate([{ $match: filter }, AMOUNT_TOTALS_STAGE]), // tổng tiền theo đúng bộ lọc của bảng
  ]);

  const counts = { all: 0 };
  ORDER_STATUSES.forEach((s) => (counts[s] = 0));
  grouped.forEach(({ _id, count }) => {
    counts[_id] = count;
    counts.all += count;
  });

  counts.cancelRequested = cancelRequested; // số đơn đang chờ duyệt yêu cầu hủy
  counts.returnRequested = returnRequested; // [TRẢ HÀNG] số đơn đang chờ duyệt yêu cầu trả hàng

  return {
    items: items.map((o) => ({ ...o, ...orderAmounts(o) })),
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
    counts,
    range,
    totals: {
      toCollect: amountAgg[0]?.toCollect ?? 0,
      collected: amountAgg[0]?.collected ?? 0,
      refunded: amountAgg[0]?.refunded ?? 0,
    },
  };
};

/* ------------------------------ tồn kho ------------------------------ */
/**
 * Tồn kho là KHO DUY NHẤT: mỗi variant có đúng 1 bản ghi Inventory,
 * nên mọi truy vấn kho chỉ lọc theo variant.
 *
 *   reserve   giữ hàng khi đặt đơn            (reservedQuantity +n)
 *   release   trả hàng đã giữ khi huỷ / hoàn  (reservedQuantity -n)
 *   complete  hàng đã giữ thành đã bán        (quantity -n và reservedQuantity -n)
 *   return    khách trả hàng, nhập lại kho    (quantity +n)
 */
const STOCK_OPS = {
  reserve: {
    type: 'order_reserve',
    // chỉ giữ được khi còn đủ hàng khả dụng: tránh 2 người mua món cuối cùng
    filter: (q) => ({
      isActive: true,
      $expr: { $gte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, q] },
    }),
    quantityDelta: () => 0,
    reservedDelta: (q) => q,
    note: (code) => `Giữ hàng cho đơn ${code}`,
    error: (it) => new HttpError(409, `"${it.name}" không còn đủ hàng`, 'INSUFFICIENT_STOCK'),
  },
  release: {
    type: 'order_release',
    filter: (q) => ({ reservedQuantity: { $gte: q } }),
    quantityDelta: () => 0,
    reservedDelta: (q) => -q,
    note: (code) => `Trả hàng giữ về kho - đơn ${code}`,
    error: () => new HttpError(500, 'Không hoàn được tồn kho, vui lòng thử lại', 'INVENTORY_RELEASE_FAILED'),
  },
  complete: {
    type: 'order_complete',
    filter: (q) => ({ quantity: { $gte: q }, reservedQuantity: { $gte: q } }),
    quantityDelta: (q) => -q,
    reservedDelta: (q) => -q,
    note: (code) => `Hoàn tất đơn ${code}, trừ tồn kho`,
    error: (it) => new HttpError(409, `"${it.name}" không đủ tồn kho để hoàn tất đơn`, 'INSUFFICIENT_STOCK'),
  },
  // [TRẢ HÀNG]
  return: {
    type: 'return',
    filter: () => ({}), // hàng đã bán ra, chỉ cần có bản ghi kho của variant
    quantityDelta: (q) => q, // dương = tăng tồn
    reservedDelta: () => 0,
    note: (code) => `Khách trả hàng, nhập lại kho - đơn ${code}`,
    error: (it) => new HttpError(404, `Không tìm thấy tồn kho của "${it.name}"`, 'INVENTORY_NOT_FOUND'),
  },
};

/**
 * Áp dụng 1 thao tác kho cho danh sách dòng { variant, quantity, name }.
 * Phải gọi bên trong 1 transaction (truyền session).
 */
const applyOrderStock = async (opName, items, { code, orderId, userId }, session) => {
  const op = STOCK_OPS[opName];
  const transactions = [];

  for (const it of items) {
    const qty = it.quantity;
    const quantityDelta = op.quantityDelta(qty);
    const reservedDelta = op.reservedDelta(qty);

    const inv = await Inventory.findOneAndUpdate(
      { variant: it.variant, ...op.filter(qty) },
      { $inc: { quantity: quantityDelta, reservedQuantity: reservedDelta } },
      { new: true, session }
    );
    if (!inv) throw op.error(it);

    transactions.push({
      variant: it.variant,
      product: inv.product,
      inventory: inv._id,
      type: op.type,
      quantity: quantityDelta,
      beforeQuantity: inv.quantity - quantityDelta,
      afterQuantity: inv.quantity,
      beforeReservedQuantity: inv.reservedQuantity - reservedDelta,
      afterReservedQuantity: inv.reservedQuantity,
      note: op.note(code),
      refOrder: orderId,
      createdBy: userId,
    });
  }

  await InventoryTransactions.insertMany(transactions, { session });
};

/** Giữ hàng cho đơn sắp tạo. items: [{ variant, quantity, name }]; ctx: { code, orderId, userId } */
export const reserveOrderStock = (items, ctx, session) => applyOrderStock('reserve', items, ctx, session);

/** Trả lại hàng đã giữ cho đơn (khi huỷ hoặc hàng hoàn về kho). */
export const releaseOrderStock = (order, userId, session) =>
  applyOrderStock('release', order.items, { code: order.code, orderId: order._id, userId }, session);

/** Trừ tồn thật khi đơn chuyển sang "completed". */
export const completeOrderStock = (order, userId, session) =>
  applyOrderStock('complete', order.items, { code: order.code, orderId: order._id, userId }, session);

/** [TRẢ HÀNG] Nhập lại kho hàng khách trả. items: [{ variant, quantity, name }] */
export const returnOrderStock = (order, items, userId, session) =>
  applyOrderStock('return', items, { code: order.code, orderId: order._id, userId }, session);

/* ------------------------------ suất giờ vàng ------------------------------ */
/**
 * Service giờ vàng có thể ném lỗi theo class riêng nên `handle` không nhận ra:
 * đổi các lỗi nghiệp vụ (status < 500) sang HttpError dùng chung.
 */
const asOrderError = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HttpError) && typeof err?.status === 'number' && err.status < 500) {
      throw new HttpError(err.status, err.message, 'FLASH_SALE_UNAVAILABLE');
    }
    throw err;
  }
};

/** Giữ suất giờ vàng cho 1 dòng của đơn: params { itemId, userId, orderId, qty }. */
export const reserveFlashForOrder = (params, session) => asOrderError(() => reserveQuota(params, session));

/** Hoàn toàn bộ suất giờ vàng đã giữ cho đơn (không có thì không làm gì, gọi nhiều lần chỉ hoàn 1 lần). */
export const releaseFlashForOrder = (order, session) =>
  asOrderError(() => releaseQuotaByOrder(order._id, session));

/** Chốt các suất giờ vàng đã giữ khi đơn hoàn tất (chuyển reserved -> completed, tính vào doanh thu). */
export const completeFlashForOrder = (order, session) =>
  asOrderError(() => completePurchasesByOrder(order._id, session));

/* ------------------------------ voucher ------------------------------ */
/**
 * Voucher service ném Error thường có .status (không phải HttpError) nên cũng đổi sang HttpError.
 * Dùng cho bước giữ chỗ voucher khi đặt đơn.
 */
export const asVoucherError = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HttpError) && typeof err?.status === 'number' && err.status < 500) {
      throw new HttpError(err.status, err.message, 'VOUCHER_INVALID');
    }
    throw err;
  }
};

/* ------------------------------ giữ / trả / chốt mọi thứ của đơn ------------------------------ */
/**
 * Trả lại MỌI THỨ đã giữ cho đơn: tồn kho + suất giờ vàng + lượt voucher.
 * Mọi chỗ huỷ đơn (khách tự huỷ, admin huỷ, admin duyệt yêu cầu huỷ) và chỗ hàng hoàn về kho
 * (returning -> returned) đều gọi hàm này.
 * Luôn gọi releaseFlashForOrder / refundVoucher (không dựa vào field trên đơn) vì đơn cũ có thể chưa lưu field đó;
 * cả hai đều không làm gì nếu đơn không dùng, và gọi nhiều lần chỉ hoàn 1 lần.
 * Phải gọi bên trong 1 transaction.
 */
export const releaseOrderReservations = async (order, userId, session) => {
  await releaseOrderStock(order, userId, session);
  await releaseFlashForOrder(order, session);
  await refundVoucher(order._id, session);
};

/**
 * Cộng số lượng đã bán vào Products.soldCount (dùng cho "Sản phẩm bán chạy", sort bán chạy...).
 * Chỉ gọi khi đơn hoàn tất, nên đơn bị huỷ / hoàn về kho không làm sai số. Gộp theo product vì 1 đơn
 * có thể có nhiều variant của cùng 1 sản phẩm.
 */
export const addProductSoldCount = async (order, session) => {
  const perProduct = new Map();
  order.items.forEach((it) => {
    const id = String(it.product);
    perProduct.set(id, (perProduct.get(id) || 0) + it.quantity);
  });
  if (perProduct.size === 0) return;

  await Products.bulkWrite(
    [...perProduct].map(([id, qty]) => ({
      updateOne: { filter: { _id: id }, update: { $inc: { soldCount: qty } } },
    })),
    { session }
  );
};

/**
 * [TRẢ HÀNG] Trừ lại Products.soldCount cho hàng bị trả (kẹp không âm).
 * items: [{ product, quantity }]
 */
export const subtractProductSoldCount = async (items, session) => {
  const perProduct = new Map();
  items.forEach((it) => {
    const id = String(it.product);
    perProduct.set(id, (perProduct.get(id) || 0) + it.quantity);
  });
  if (perProduct.size === 0) return;

  await Products.bulkWrite(
    [...perProduct].map(([id, qty]) => ({
      updateOne: {
        filter: { _id: id },
        // pipeline update để kẹp không âm
        update: [{ $set: { soldCount: { $max: [0, { $subtract: [{ $ifNull: ['$soldCount', 0] }, qty] }] } } }],
      },
    })),
    { session }
  );
};

/**
 * Chốt MỌI THỨ khi đơn hoàn tất: trừ tồn thật + chốt suất giờ vàng + cộng số đã bán + chốt voucher.
 * Phải gọi bên trong 1 transaction.
 */
export const completeOrderReservations = async (order, userId, session) => {
  await completeOrderStock(order, userId, session);
  await completeFlashForOrder(order, session);
  await addProductSoldCount(order, session);
  await markVoucherUsed(order._id, session);
};

/* ------------------------------ quy định hủy đơn của khách ------------------------------ */
/**
 * Khách chỉ tự hủy được khi đơn còn "pending" VÀ trong vòng N phút kể từ lúc đặt (mặc định 15).
 * Quá thời gian đó, hoặc đơn đã "confirmed", khách chỉ gửi được YÊU CẦU HỦY và admin phải duyệt.
 * Đổi số phút bằng biến môi trường ORDER_CANCEL_WINDOW_MINUTES.
 */
export const USER_CANCEL_WINDOW_MINUTES = Number(process.env.ORDER_CANCEL_WINDOW_MINUTES) || 15;
export const USER_CANCEL_WINDOW_MS = USER_CANCEL_WINDOW_MINUTES * 60 * 1000;

/**
 * Khách đang được làm gì với đơn này:
 *   direct    tự hủy ngay (còn trong thời gian cho phép)
 *   request   được gửi yêu cầu hủy để admin duyệt
 *   requested đã gửi yêu cầu, đang chờ admin
 *   none      không hủy được nữa
 */
export const getCancelPolicy = (order, now = Date.now()) => {
  const directUntil = new Date(new Date(order.createdAt).getTime() + USER_CANCEL_WINDOW_MS);
  const requestStatus = order.cancelRequest?.status;

  let mode = 'none';
  if (order.status === 'pending' && now <= directUntil.getTime()) {
    mode = 'direct';
  } else if (['pending', 'confirmed'].includes(order.status)) {
    if (requestStatus === 'pending') mode = 'requested';
    else if (requestStatus !== 'rejected') mode = 'request';
  }

  return { mode, directUntil, windowMinutes: USER_CANCEL_WINDOW_MINUTES };
};

// Gắn cancelPolicy vào đơn trả cho khách để FE biết hiện nút nào
export const withCancelPolicy = (order) => ({ ...order, cancelPolicy: getCancelPolicy(order) });

// Lỗi trả về khi khách bấm "Hủy đơn" nhưng không được tự hủy
export const explainCancelFailure = (order) => {
  if (order.status === 'cancelled') {
    return new HttpError(409, 'Đơn hàng đã được hủy', 'ORDER_ALREADY_CANCELLED');
  }
  if (['shipping', 'completed', 'returning', 'returned'].includes(order.status)) {
    return new HttpError(409, 'Đơn hàng đã được giao đi, không thể hủy', 'ORDER_NOT_CANCELLABLE');
  }
  if (order.cancelRequest?.status === 'pending') {
    return new HttpError(409, 'Bạn đã gửi yêu cầu hủy, vui lòng chờ cửa hàng xử lý', 'CANCEL_REQUEST_PENDING');
  }
  if (order.cancelRequest?.status === 'rejected') {
    return new HttpError(409, 'Yêu cầu hủy của bạn đã bị từ chối, không thể hủy đơn này', 'CANCEL_REQUEST_REJECTED');
  }
  const why =
    order.status === 'pending'
      ? `Đã quá ${USER_CANCEL_WINDOW_MINUTES} phút kể từ khi đặt hàng`
      : 'Đơn hàng đã được cửa hàng xác nhận';
  return new HttpError(
    409,
    `${why}, bạn không thể tự hủy đơn. Vui lòng gửi yêu cầu hủy để cửa hàng xem xét.`,
    'CANCEL_REQUEST_REQUIRED'
  );
};

// Lỗi trả về khi khách gửi yêu cầu hủy nhưng không hợp lệ
export const explainRequestFailure = (order) => {
  const requestStatus = order.cancelRequest?.status;
  if (order.status === 'pending' && requestStatus !== 'pending' && requestStatus !== 'rejected') {
    return new HttpError(
      409,
      `Bạn có thể tự hủy đơn trong ${USER_CANCEL_WINDOW_MINUTES} phút đầu sau khi đặt hàng`,
      'CANCEL_DIRECT_AVAILABLE'
    );
  }
  return explainCancelFailure(order);
};

/* ------------------------------ [TRẢ HÀNG] quy định trả hàng của khách ------------------------------ */
/**
 * Khách chỉ gửi được yêu cầu trả hàng khi đơn "completed" và trong vòng N ngày kể từ lúc hoàn tất
 * (mặc định 7). Đổi bằng biến môi trường ORDER_RETURN_WINDOW_DAYS.
 * Mốc thời gian lấy từ bản ghi "completed" cuối cùng trong statusHistory, nên KHÔNG push thêm
 * entry "completed" vào statusHistory khi xử lý trả hàng.
 */
export const RETURN_WINDOW_DAYS = Number(process.env.ORDER_RETURN_WINDOW_DAYS) || 7;
export const RETURN_WINDOW_MS = RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const getCompletedAt = (order) => {
  const h = [...(order.statusHistory || [])].reverse().find((x) => x.status === 'completed');
  return h?.changedAt ? new Date(h.changedAt) : null;
};

/**
 * Khách đang được làm gì với đơn này:
 *   request   được gửi yêu cầu trả hàng
 *   requested đã gửi (pending | approved | rejected | completed), xem returnRequest.status
 *   none      không trả được (chưa completed hoặc quá hạn)
 */
export const getReturnPolicy = (order, now = Date.now()) => {
  const completedAt = getCompletedAt(order);
  const deadline = completedAt ? new Date(completedAt.getTime() + RETURN_WINDOW_MS) : null;
  const requestStatus = order.returnRequest?.status || 'none';

  let mode = 'none';
  if (order.status === 'completed') {
    if (requestStatus !== 'none') mode = 'requested';
    else if (deadline && now <= deadline.getTime()) mode = 'request';
  }
  return { mode, deadline, windowDays: RETURN_WINDOW_DAYS, status: requestStatus };
};

// Gắn returnPolicy vào đơn trả cho khách để FE biết hiện nút "Trả hàng" hay không
export const withReturnPolicy = (order) => ({ ...order, returnPolicy: getReturnPolicy(order) });

// Gắn cả cancelPolicy và returnPolicy
export const withOrderPolicies = (order) => withReturnPolicy(withCancelPolicy(order));

// Lỗi trả về khi khách gửi yêu cầu trả hàng nhưng không hợp lệ
export const explainReturnFailure = (order) => {
  if (order.status !== 'completed') {
    return new HttpError(409, 'Chỉ đơn đã hoàn tất mới được trả hàng', 'RETURN_NOT_ALLOWED');
  }
  if ((order.returnRequest?.status || 'none') !== 'none') {
    return new HttpError(409, 'Đơn này đã gửi yêu cầu trả hàng', 'RETURN_ALREADY_REQUESTED');
  }
  return new HttpError(
    409,
    `Đã quá ${RETURN_WINDOW_DAYS} ngày kể từ khi nhận hàng, không thể trả hàng`,
    'RETURN_WINDOW_EXPIRED'
  );
};

/**
 * Chuẩn hóa danh sách dòng trả. Không gửi items = trả toàn bộ đơn (phần chưa trả).
 * Trả về [{ orderItem, quantity }]
 */
export const normalizeReturnItems = (order, raw) => {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return order.items
      .map((l) => ({ orderItem: l._id, quantity: l.quantity - (l.returnedQuantity || 0) }))
      .filter((x) => x.quantity > 0);
  }
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Danh sách sản phẩm trả không hợp lệ', 'INVALID_RETURN_ITEMS');
  }

  const lines = new Map(order.items.map((l) => [String(l._id), l]));
  const seen = new Set();

  return raw.map((r) => {
    const id = String(r?.orderItem);
    const line = lines.get(id);
    if (!mongoose.Types.ObjectId.isValid(id) || !line) {
      throw new HttpError(400, 'Sản phẩm trả không thuộc đơn hàng', 'INVALID_RETURN_ITEMS');
    }
    if (seen.has(id)) {
      throw new HttpError(400, 'Sản phẩm bị trùng trong danh sách trả', 'INVALID_RETURN_ITEMS');
    }
    seen.add(id);

    const quantity = Number(r.quantity);
    const max = line.quantity - (line.returnedQuantity || 0);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
      throw new HttpError(400, `Số lượng trả không hợp lệ: ${line.name}`, 'INVALID_RETURN_QUANTITY');
    }
    return { orderItem: line._id, quantity };
  });
};

/**
 * Tiền hoàn tối đa cho các dòng trả: giá trị hàng trừ phần giảm giá voucher phân bổ theo tỷ lệ.
 * KHÔNG hoàn phí ship. (Giả định voucher giảm trên tiền hàng.)
 * returnItems: [{ orderItem, quantity }]
 */
export const calcRefundAmount = (order, returnItems) => {
  const lines = new Map(order.items.map((l) => [String(l._id), l]));
  const itemsValue = returnItems.reduce(
    (sum, r) => sum + lines.get(String(r.orderItem)).unitPrice * r.quantity,
    0
  );
  const discountShare = order.subtotal > 0 ? Math.round((order.discount * itemsValue) / order.subtotal) : 0;
  return Math.max(0, itemsValue - discountShare);
};