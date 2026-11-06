import mongoose from 'mongoose';
import Orders from '../../models/orders/ordersModel.js'; // chỉnh lại đường dẫn cho đúng dự án
import Users from '../../models/users/userModel.js';
import Products from '../../models/products/productModel.js';
import Banner, { BANNER_TYPES } from '../../models/banner/bannerModel.js';
import RepairRequest from '../../models/repairr/repairrequestMode.js'; // chỉnh lại đường dẫn cho đúng dự án

/* ============================== Hằng số & helper ============================== */

const TZ = 'Asia/Ho_Chi_Minh';
const VN_OFFSET = 7 * 60 * 60 * 1000; // UTC+7, Việt Nam không có giờ mùa hè
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// Định dạng khóa gom nhóm theo từng đơn vị thời gian
const FORMATS = { hour: '%Y-%m-%d %H', day: '%Y-%m-%d', month: '%Y-%m' };

// Tên role của khách hàng trong collection Role (đổi bằng biến môi trường nếu khác)
const CUSTOMER_ROLE_NAME = process.env.CUSTOMER_ROLE_NAME || 'USER';

// Gom 7 trạng thái của đơn thành 5 nhóm hiển thị trên dashboard
const STATUS_GROUPS = [
  { key: 'processing', label: 'Đang xử lý', statuses: ['pending', 'confirmed'] },
  { key: 'shipping', label: 'Đang giao', statuses: ['shipping'] },
  { key: 'delivered', label: 'Đã giao', statuses: ['completed'] },
  { key: 'cancelled', label: 'Đã hủy', statuses: ['cancelled'] },
  { key: 'returned', label: 'Trả hàng', statuses: ['returning', 'returned'] },
];

// Gom các trạng thái của đơn SỬA CHỮA thành 5 nhóm cho biểu đồ donut
const REPAIR_STATUS_GROUPS = [
  { key: 'waiting', label: 'Chờ xử lý', statuses: ['pending', 'confirmed', 'received'] },
  { key: 'processing', label: 'Đang sửa', statuses: ['assigned', 'in_progress', 'waiting_parts'] },
  { key: 'repaired', label: 'Đã sửa xong', statuses: ['repaired'] },
  { key: 'completed', label: 'Hoàn thành', statuses: ['completed'] },
  { key: 'cancelled', label: 'Đã hủy / từ chối', statuses: ['cancelled', 'rejected'] },
];

const groupOfStatus = (status) => STATUS_GROUPS.find((g) => g.statuses.includes(status));

// Doanh thu thực = tổng đơn - số tiền đã hoàn trả cho khách
const REVENUE_EXPR = { $subtract: ['$total', { $ifNull: ['$refundedAmount', 0] }] };

// Số sản phẩm bán ra của 1 đơn = tổng (quantity - returnedQuantity)
const ITEMS_EXPR = {
  $reduce: {
    input: '$items',
    initialValue: 0,
    in: {
      $add: [
        '$$value',
        { $subtract: ['$$this.quantity', { $ifNull: ['$$this.returnedQuantity', 0] }] },
      ],
    },
  },
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[dashboard]', err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'Lỗi máy chủ' });
  }
};

/* ------------------------------- Mốc thời gian (giờ VN) ------------------------------- */

const parseVNDate = (str) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) throw httpError(400, 'Ngày không hợp lệ (YYYY-MM-DD)');
  const d = new Date(`${str}T00:00:00+07:00`);
  if (Number.isNaN(d.getTime())) throw httpError(400, 'Ngày không hợp lệ (YYYY-MM-DD)');
  return d;
};

const startOfDayVN = (date) => {
  const t = new Date(date.getTime() + VN_OFFSET);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - VN_OFFSET);
};

// Đầu tuần (thứ 2) theo giờ VN
const startOfWeekVN = (date) => {
  const t = startOfDayVN(date);
  const dow = new Date(t.getTime() + VN_OFFSET).getUTCDay(); // 0 = CN
  return new Date(t.getTime() - ((dow + 6) % 7) * DAY);
};

// Đầu tháng VN, cộng thêm addMonths tháng
const startOfMonthVN = (date, addMonths = 0) => {
  const s = new Date(date.getTime() + VN_OFFSET);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + addMonths, 1) - VN_OFFSET);
};

// Đầu quý VN, cộng thêm addQuarters quý
const startOfQuarterVN = (date, addQuarters = 0) => {
  const s = new Date(date.getTime() + VN_OFFSET);
  const qMonth = s.getUTCMonth() - (s.getUTCMonth() % 3);
  return new Date(Date.UTC(s.getUTCFullYear(), qMonth + addQuarters * 3, 1) - VN_OFFSET);
};

// Đầu năm VN, cộng thêm addYears năm
const startOfYearVN = (date, addYears = 0) => {
  const y = new Date(date.getTime() + VN_OFFSET).getUTCFullYear();
  return new Date(Date.UTC(y + addYears, 0, 1) - VN_OFFSET);
};

/* ------------------------------- Khóa thời gian (trục X) ------------------------------- */

const dayKey = (date) => new Date(date.getTime() + VN_OFFSET).toISOString().slice(0, 10); // YYYY-MM-DD

const hourKeys = (from, to) => {
  const keys = [];
  for (let t = from.getTime(); t < to.getTime(); t += HOUR) {
    keys.push(new Date(t + VN_OFFSET).toISOString().slice(0, 13).replace('T', ' ')); // YYYY-MM-DD HH
  }
  return keys;
};

const dayKeys = (from, to) => {
  const keys = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) keys.push(dayKey(new Date(t)));
  return keys;
};

// `to` là mốc loại trừ nên lùi 1ms để không dư tháng cuối
const monthKeys = (from, to) => {
  const s = new Date(from.getTime() + VN_OFFSET);
  const e = new Date(to.getTime() - 1 + VN_OFFSET);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  const ey = e.getUTCFullYear();
  const em = e.getUTCMonth();
  const keys = [];
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return keys;
};

const keysOf = (unit, from, to) =>
  unit === 'hour' ? hourKeys(from, to) : unit === 'month' ? monthKeys(from, to) : dayKeys(from, to);

const labelOf = (key) => {
  if (key.length === 13) return `${key.slice(11, 13)}h`; // 'YYYY-MM-DD HH' -> '14h'
  if (key.length === 10) return `${key.slice(8, 10)}/${key.slice(5, 7)}`; // -> 'DD/MM'
  return `T${Number(key.slice(5, 7))}`; // 'YYYY-MM' -> 'T10'
};

// Tự chọn đơn vị trục X theo độ dài khoảng thời gian
const pickUnit = (from, to) => {
  const span = to.getTime() - from.getTime();
  if (span <= 2 * DAY) return 'hour';
  if (span <= 93 * DAY) return 'day';
  return 'month';
};

/* ------------------------------- Đọc bộ lọc ------------------------------- */

/**
 * range: all | day | week | month | quarter | year | custom | 7d | 30d | 90d
 * date : ngày bất kỳ trong kỳ (day/week/month/quarter/year), mặc định hôm nay
 * from, to: dùng cho custom (YYYY-MM-DD, gồm cả ngày `to`)
 * Trả về { key, unit, from, to, prev } — prev = null nếu không có kỳ trước (all).
 */
const resolveRange = async (query = {}) => {
  const key = query.range || '30d';
  const now = new Date();
  const anchor = query.date ? parseVNDate(query.date) : now;
  let from;
  let to;

  if (RANGE_DAYS[key]) {
    from = new Date(startOfDayVN(now).getTime() - (RANGE_DAYS[key] - 1) * DAY);
    to = now;
  } else {
    switch (key) {
      case 'day':
        from = startOfDayVN(anchor);
        to = new Date(from.getTime() + DAY);
        break;
      case 'week':
        from = startOfWeekVN(anchor);
        to = new Date(from.getTime() + 7 * DAY);
        break;
      case 'month':
        from = startOfMonthVN(anchor);
        to = startOfMonthVN(anchor, 1);
        break;
      case 'quarter':
        from = startOfQuarterVN(anchor);
        to = startOfQuarterVN(anchor, 1);
        break;
      case 'year':
        from = startOfYearVN(anchor);
        to = startOfYearVN(anchor, 1);
        break;
      case 'custom': {
        from = startOfDayVN(parseVNDate(query.from));
        to = new Date(startOfDayVN(parseVNDate(query.to)).getTime() + DAY);
        if (to <= from) throw httpError(400, '"Đến ngày" phải sau hoặc bằng "Từ ngày"');
        if (to - from > 5 * 366 * DAY) throw httpError(400, 'Khoảng thời gian tối đa 5 năm');
        break;
      }
      case 'all': {
        const [o, r, u] = await Promise.all([
          Orders.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
          RepairRequest.findOne({ isDeleted: { $ne: true } })
            .sort({ createdAt: 1 })
            .select('createdAt')
            .lean(),
          Users.findOne().sort({ createdAt: 1 }).select('createdAt').lean(),
        ]);
        const dates = [o, r, u].filter(Boolean).map((x) => x.createdAt.getTime());
        from = startOfDayVN(new Date(dates.length ? Math.min(...dates) : now.getTime() - 30 * DAY));
        to = now;
        break;
      }
      default:
        throw httpError(
          400,
          'range không hợp lệ (all | day | week | month | quarter | year | custom | 7d | 30d | 90d)'
        );
    }
  }

  const length = to.getTime() - from.getTime();
  return {
    key,
    unit: pickUnit(from, to),
    from,
    to,
    // "Tất cả thời gian" không có kỳ trước để so sánh
    prev: key === 'all' ? null : { from: new Date(from.getTime() - length), to: from },
  };
};

/* ------------------------------- Tính toán chung ------------------------------- */

const percentChange = (current, previous) => {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10; // 1 chữ số thập phân
};

const sumOf = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);

const toSeries = (keys, rows, field) => {
  const map = new Map(rows.map((r) => [r._id, r]));
  return keys.map((k) => map.get(k)?.[field] ?? 0);
};

// Kỳ trước có thể là null (range=all) -> trả mảng rỗng
const whenPrev = (prev, fn) => (prev ? fn(prev.from, prev.to) : Promise.resolve([]));

/** Gom đơn hàng theo giờ / ngày / tháng (giờ VN) */
const aggregateOrders = (from, to, unit = 'day') =>
  Orders.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: { $dateToString: { format: FORMATS[unit], date: '$createdAt', timezone: TZ } },
        orders: { $sum: 1 },
        // Chỉ đơn đã hoàn tất mới tính doanh thu và số lượng bán
        revenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, REVENUE_EXPR, 0] } },
        productsSold: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, ITEMS_EXPR, 0] } },
      },
    },
  ]);

/**
 * Gom đơn SỬA CHỮA theo giờ / ngày / tháng (giờ VN) dựa trên 1 trường ngày bất kỳ.
 * - dateField: 'paidAt' (doanh thu thực thu) | 'completedAt' | 'createdAt'
 * - extraMatch: điều kiện thêm, vd { status: 'completed', isPaid: true }
 * aggregate không đi qua middleware find nên phải tự loại bản ghi đã xóa mềm.
 */
const aggregateRepairs = (dateField, from, to, unit = 'day', extraMatch = {}) =>
  RepairRequest.aggregate([
    {
      $match: {
        isDeleted: { $ne: true },
        ...extraMatch,
        [dateField]: { $gte: from, $lt: to },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: FORMATS[unit], date: `$${dateField}`, timezone: TZ } },
        count: { $sum: 1 },
        revenue: { $sum: '$finalCost' },
      },
    },
  ]);

// Doanh thu sửa chữa = đơn hoàn thành VÀ đã thanh toán, tính theo ngày thanh toán
const PAID_REPAIR_MATCH = { status: 'completed', isPaid: true };

/** Chỉ đếm tài khoản có role là khách hàng (bỏ admin/nhân viên). Không tìm thấy role thì đếm tất cả */
const getCustomerFilter = async () => {
  try {
    const Role = mongoose.model('Role');
    const role = await Role.findOne({ name: CUSTOMER_ROLE_NAME }).select('_id').lean();
    if (role) return { role: role._id };
  } catch {
    /* model Role chưa đăng ký -> bỏ lọc */
  }
  return {};
};

const aggregateCustomers = (from, to, roleFilter, unit = 'day') =>
  Users.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, ...roleFilter } },
    {
      $group: {
        _id: { $dateToString: { format: FORMATS[unit], date: '$createdAt', timezone: TZ } },
        newCustomers: { $sum: 1 },
      },
    },
  ]);

/* ================================== Controllers ================================== */

/** GET /dashboard/summary  ->  4 thẻ thống kê + dữ liệu sparkline */
export const getSummary = handle(async (req, res) => {
  const { key, unit, from, to, prev } = await resolveRange(req.query);
  const roleFilter = await getCustomerFilter();

  const [curOrders, prevOrders, curCustomers, prevCustomers] = await Promise.all([
    aggregateOrders(from, to, unit),
    whenPrev(prev, (f, t) => aggregateOrders(f, t, unit)),
    aggregateCustomers(from, to, roleFilter, unit),
    whenPrev(prev, (f, t) => aggregateCustomers(f, t, roleFilter, unit)),
  ]);

  const keys = keysOf(unit, from, to);

  const card = (curRows, prevRows, field) => {
    const value = sumOf(curRows, field);
    const previous = sumOf(prevRows, field);
    return {
      value,
      previous: prev ? previous : null,
      change: prev ? percentChange(value, previous) : null, // null khi range=all
      trend: toSeries(keys, curRows, field), // mảng số cho biểu đồ nhỏ
    };
  };

  res.json({
    success: true,
    data: {
      range: key,
      unit,
      from,
      to,
      totalOrders: card(curOrders, prevOrders, 'orders'),
      revenue: card(curOrders, prevOrders, 'revenue'),
      newCustomers: card(curCustomers, prevCustomers, 'newCustomers'),
      productsSold: card(curOrders, prevOrders, 'productsSold'),
    },
  });
});

/** GET /dashboard/revenue  ->  doanh thu theo giờ / ngày / tháng tùy độ dài kỳ */
export const getRevenueChart = handle(async (req, res) => {
  const { key, unit, from, to } = await resolveRange(req.query);

  const rows = await aggregateOrders(from, to, unit);
  const keys = keysOf(unit, from, to);
  const revenue = toSeries(keys, rows, 'revenue');
  const orders = toSeries(keys, rows, 'orders');

  res.json({
    success: true,
    data: {
      range: key,
      unit,
      total: revenue.reduce((s, v) => s + v, 0),
      points: keys.map((k, i) => ({
        key: k,
        label: labelOf(k),
        revenue: revenue[i], // đơn vị: VND (frontend tự đổi sang "tr")
        orders: orders[i],
      })),
    },
  });
});

/** GET /dashboard/order-status  ->  số đơn theo nhóm trạng thái (biểu đồ donut) */
export const getOrderStatus = handle(async (req, res) => {
  const { key, from, to } = await resolveRange(req.query);

  const rows = await Orders.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const total = rows.reduce((s, r) => s + r.count, 0);

  const items = STATUS_GROUPS.map((g) => {
    const count = g.statuses.reduce((s, st) => s + (counts[st] || 0), 0);
    return {
      key: g.key,
      label: g.label,
      count,
      percent: total ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });

  res.json({ success: true, data: { range: key, total, items } });
});

/** GET /dashboard/recent-orders?limit=5  ->  đơn hàng mới nhất */
export const getRecentOrders = handle(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

  const orders = await Orders.find(
    {},
    {
      code: 1,
      total: 1,
      status: 1,
      createdAt: 1,
      'shippingAddress.fullName': 1,
      items: { $slice: 1 }, // chỉ lấy dòng đầu để làm ảnh đại diện
    }
  )
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const data = orders.map((o) => {
    const group = groupOfStatus(o.status);
    const first = o.items?.[0];
    return {
      _id: o._id,
      code: o.code,
      customer: o.shippingAddress?.fullName || '',
      total: o.total,
      status: o.status,
      statusGroup: group?.key,
      statusLabel: group?.label,
      thumbnail: first?.image || '',
      productName: first?.name || '',
      createdAt: o.createdAt,
    };
  });

  res.json({ success: true, data });
});

/** GET /dashboard/banners?type=main&limit=5  ->  banner khuyến mãi đang hiển thị */
export const getPromoBanners = handle(async (req, res) => {
  const type = req.query.type || 'main';
  if (!BANNER_TYPES.includes(type)) throw httpError(400, 'Loại banner không hợp lệ');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

  const banners = await Banner.findPublic(type)
    .limit(limit)
    .select('type image link alt order')
    .lean();

  res.json({ success: true, data: banners });
});

/** GET /dashboard/top-products?limit=5  ->  sản phẩm bán chạy nhất */
export const getTopProducts = handle(async (req, res) => {
  const { key, from, to } = await resolveRange(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

  // Gom theo sản phẩm (gộp mọi biến thể), chỉ tính đơn đã hoàn tất
  const rows = await Orders.aggregate([
    { $match: { status: 'completed', createdAt: { $gte: from, $lt: to } } },
    { $sort: { createdAt: -1 } }, // để $first lấy tên/ảnh của đơn mới nhất
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        sold: {
          $sum: { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] },
        },
        revenue: {
          $sum: {
            $multiply: [
              '$items.unitPrice',
              { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] },
            ],
          },
        },
        orders: { $addToSet: '$_id' },
        snapshotName: { $first: '$items.name' },
        snapshotImage: { $first: '$items.image' },
      },
    },
    { $match: { sold: { $gt: 0 } } },
    { $addFields: { orders: { $size: '$orders' } } },
    { $sort: { sold: -1, revenue: -1 } },
    { $limit: limit },
  ]);

  // Lấy thông tin hiện tại của sản phẩm (tên, ảnh, slug...); nếu đã xóa thì dùng snapshot trong đơn
  const products = await Products.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('name slug images priceMin ratingAverage')
    .lean();
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const data = rows.map((r, i) => {
    const p = productMap.get(String(r._id));
    return {
      rank: i + 1,
      productId: r._id,
      name: p?.name || r.snapshotName,
      slug: p?.slug || '',
      image: p?.images?.[0]?.url || r.snapshotImage || '',
      price: p?.priceMin ?? null,
      ratingAverage: p?.ratingAverage ?? 0,
      sold: r.sold, // số lượng bán ra (đã trừ hàng trả)
      revenue: r.revenue, // VND
      orders: r.orders, // số đơn chứa sản phẩm này
    };
  });

  res.json({ success: true, data: { range: key, items: data } });
});

/* =============================== SỬA CHỮA =============================== */

/**
 * GET /dashboard/repair/summary  ->  thẻ doanh thu sửa chữa
 * Doanh thu = tổng finalCost của đơn hoàn thành VÀ đã thanh toán, tính theo NGÀY THANH TOÁN (paidAt).
 */
export const getRepairSummary = handle(async (req, res) => {
  const { key, unit, from, to, prev } = await resolveRange(req.query);

  const [cur, previous] = await Promise.all([
    aggregateRepairs('paidAt', from, to, unit, PAID_REPAIR_MATCH),
    whenPrev(prev, (f, t) => aggregateRepairs('paidAt', f, t, unit, PAID_REPAIR_MATCH)),
  ]);

  const keys = keysOf(unit, from, to);
  const value = sumOf(cur, 'revenue');
  const prevValue = sumOf(previous, 'revenue');

  res.json({
    success: true,
    data: {
      range: key,
      unit,
      from,
      to,
      revenue: {
        value,
        previous: prev ? prevValue : null,
        change: prev ? percentChange(value, prevValue) : null, // null khi range=all
        trend: toSeries(keys, cur, 'revenue'),
      },
    },
  });
});

/** GET /dashboard/repair/revenue  ->  doanh thu sửa chữa theo giờ / ngày / tháng */
export const getRepairRevenueChart = handle(async (req, res) => {
  const { key, unit, from, to } = await resolveRange(req.query);

  const rows = await aggregateRepairs('paidAt', from, to, unit, PAID_REPAIR_MATCH);
  const keys = keysOf(unit, from, to);
  const revenue = toSeries(keys, rows, 'revenue');
  const orders = toSeries(keys, rows, 'count');

  res.json({
    success: true,
    data: {
      range: key,
      unit,
      total: revenue.reduce((s, v) => s + v, 0),
      points: keys.map((k, i) => ({
        key: k,
        label: labelOf(k),
        revenue: revenue[i], // VND
        orders: orders[i], // số đơn sửa chữa đã thu tiền trong khoảng thời gian
      })),
    },
  });
});

/** GET /dashboard/repair/status  ->  số đơn sửa chữa theo nhóm trạng thái (donut), tính theo ngày tạo */
export const getRepairStatus = handle(async (req, res) => {
  const { key, from, to } = await resolveRange(req.query);

  const rows = await RepairRequest.aggregate([
    { $match: { isDeleted: { $ne: true }, createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const total = rows.reduce((s, r) => s + r.count, 0);

  const items = REPAIR_STATUS_GROUPS.map((g) => {
    const count = g.statuses.reduce((s, st) => s + (counts[st] || 0), 0);
    return {
      key: g.key,
      label: g.label,
      count,
      percent: total ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });

  res.json({ success: true, data: { range: key, total, items } });
});