import mongoose from 'mongoose';
import FlashSales from '../../models/flashSale/flashSalesModel.js';
import FlashSaleItems from '../../models/flashSale/flashSaleItemsModel.js';
import Products from '../../models/products/productModel.js';
import ProductVariants from '../../models/products/productVariantModel.js';
import Inventory from '../../models/inventory/inventoryModel.js';
import FlashSalePurchases from '../../models/flashSale/flashSalePurchaseModel.js';
import { HttpError } from '../../utils/httpError.js';

const ObjectId = mongoose.Types.ObjectId;

/* =========================== Helpers nội bộ =========================== */

/** Tồn kho khả dụng trong kho tổng = quantity - reservedQuantity. */
async function getAvailableStock(variantId) {
  const inv = await Inventory.findOne({ variant: variantId, isActive: true }).lean();
  if (!inv) return 0;
  return Math.max(0, (inv.quantity || 0) - (inv.reservedQuantity || 0));
}

/** Pha của đợt, tính động theo thời gian server. */
export function phaseOf(sale, now = new Date()) {
  if (sale.status === 'cancelled') return 'cancelled';
  if (sale.status === 'draft') return 'draft';
  if (now < sale.startTime) return 'upcoming';
  if (now >= sale.endTime) return 'ended';
  return 'running';
}

async function loadEditableSale(id) {
  const sale = await FlashSales.findById(id);
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  const phase = phaseOf(sale);
  if (phase === 'cancelled' || phase === 'ended') {
    throw new HttpError(409, `Đợt đã ${phase === 'ended' ? 'kết thúc' : 'bị hủy'}, không thể chỉnh sửa`);
  }
  return sale;
}

/**
 * Tìm item của đợt KHÁC (chưa hủy) có thời gian chồng lên [start, end]
 * cho cùng variant. Trả về item xung đột hoặc null.
 */
async function findConflict(variantId, start, end, excludeSaleId) {
  const sales = await FlashSales.find({
    _id: { $ne: excludeSaleId },
    status: { $ne: 'cancelled' },
    startTime: { $lt: end },
    endTime: { $gt: start },
  })
    .select('_id name')
    .lean();
  if (!sales.length) return null;

  const item = await FlashSaleItems.findOne({
    flashSale: { $in: sales.map((s) => s._id) },
    variant: variantId,
  }).lean();
  if (!item) return null;
  const sale = sales.find((s) => String(s._id) === String(item.flashSale));
  return { item, saleName: sale?.name };
}

/** Giá niêm yết áp dụng cho variant: giá riêng của variant, không có thì kế thừa giá product. */
const resolveBasePricing = (variant, product) =>
  variant?.pricing?.price != null ? variant.pricing : product?.pricing;

/** Kiểm tra giá flash so với giá bán hiện tại. Trả về cảnh báo nếu thấp hơn giá vốn. */
function checkPricing(variant, product, flashPrice) {
  const pricing = resolveBasePricing(variant, product);
  if (!pricing || !(pricing.price > 0)) {
    throw new HttpError(422, 'Biến thể chưa có giá bán');
  }
  if (flashPrice >= pricing.price) {
    throw new HttpError(422, `flashPrice phải nhỏ hơn giá bán hiện tại (${pricing.price})`);
  }
  const warning =
    pricing.costPrice > 0 && flashPrice < pricing.costPrice
      ? `flashPrice thấp hơn giá vốn (${pricing.costPrice})`
      : null;
  return { pricing, warning };
}

/* ============================== Admin: đợt ============================== */

/** Sinh mã dạng FS-2024-001 theo năm của startTime (số thứ tự tăng dần trong năm). */
async function generateCode(year) {
  const prefix = `FS-${year}-`;
  const last = await FlashSales.findOne({ code: new RegExp(`^${prefix}`) })
    .sort({ code: -1 })
    .collation({ locale: 'en', numericOrdering: true })
    .select('code')
    .lean();
  const next = last ? parseInt(last.code.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

export async function createFlashSale(data, userId = null) {
  const year = data.startTime.getFullYear();
  // Hai admin tạo cùng lúc có thể sinh trùng mã -> unique index chặn, thử lại với mã mới
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const code = await generateCode(year);
      return await FlashSales.create({ ...data, code, status: 'draft', createdBy: userId });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new HttpError(409, 'Không sinh được mã chương trình, vui lòng thử lại');
}

const PHASE_LABELS = {
  draft: 'Nháp',
  upcoming: 'Sắp diễn ra',
  running: 'Đang diễn ra',
  ended: 'Đã kết thúc',
  cancelled: 'Đã hủy',
};

// Nút hành động hiển thị theo pha (khớp bảng admin)
const ACTIONS_BY_PHASE = {
  draft: ['edit', 'view', 'add_items', 'publish', 'cancel'],
  upcoming: ['edit', 'view', 'add_items', 'cancel'],
  running: ['view', 'add_items', 'end_now', 'cancel'],
  ended: ['view'],
  cancelled: ['view'],
};

export async function listFlashSales({ page, limit, phase, search }) {
  const now = new Date();
  const q = {};
  switch (phase) {
    case 'draft': q.status = 'draft'; break;
    case 'cancelled': q.status = 'cancelled'; break;
    case 'upcoming': Object.assign(q, { status: 'active', startTime: { $gt: now } }); break;
    case 'running': Object.assign(q, { status: 'active', startTime: { $lte: now }, endTime: { $gt: now } }); break;
    case 'ended': Object.assign(q, { status: 'active', endTime: { $lte: now } }); break;
    default: break;
  }
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: re }, { code: re }];
  }

  const [rows, total] = await Promise.all([
    FlashSales.find(q).sort({ startTime: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    FlashSales.countDocuments(q),
  ]);

  // Gộp số liệu cho cả trang bằng 2 aggregate (không query từng dòng)
  const ids = rows.map((r) => r._id);
  const [itemStats, revenueStats] = ids.length
    ? await Promise.all([
        FlashSaleItems.aggregate([
          { $match: { flashSale: { $in: ids } } },
          {
            $group: {
              _id: '$flashSale',
              skuCount: { $sum: 1 }, // mỗi item = 1 variant (unique theo flashSale + variant)
              totalQuota: { $sum: '$quota' },
              totalSold: { $sum: '$sold' },
            },
          },
        ]),
        // Doanh thu chỉ tính các suất của đơn đã hoàn tất
        FlashSalePurchases.aggregate([
          { $match: { flashSale: { $in: ids }, status: 'completed' } },
          { $group: { _id: '$flashSale', revenue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } } } },
        ]),
      ])
    : [[], []];

  const itemMap = new Map(itemStats.map((s) => [String(s._id), s]));
  const revenueMap = new Map(revenueStats.map((s) => [String(s._id), s.revenue]));

  const items = rows.map((s) => {
    const key = String(s._id);
    const st = itemMap.get(key);
    const totalQuota = st?.totalQuota ?? 0;
    const totalSold = st?.totalSold ?? 0;
    const p = phaseOf(s, now);
    return {
      id: s._id,
      code: s.code ?? null,
      name: s.name,
      subtitle: s.subtitle ?? '',
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      phase: p,
      phaseLabel: PHASE_LABELS[p],
      skuCount: st?.skuCount ?? 0,
      totalQuota,
      totalSold,
      soldPercent: totalQuota ? Math.round((totalSold / totalQuota) * 1000) / 10 : 0,
      revenue: revenueMap.get(key) ?? 0,
      actions: ACTIONS_BY_PHASE[p],
    };
  });

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getFlashSaleDetail(id) {
  const sale = await FlashSales.findById(id).lean();
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  const items = await FlashSaleItems.find({ flashSale: id })
    .populate({ path: 'product', select: 'name slug pricing' })
    .populate({ path: 'variant', select: 'sku attributes image pricing' })
    .lean();
  return { ...sale, phase: phaseOf(sale), items };
}

export async function updateFlashSale(id, data) {
  const sale = await loadEditableSale(id);
  const now = new Date();

  const started = sale.status === 'active' && now >= sale.startTime;
  if (started && data.startTime && data.startTime.getTime() !== sale.startTime.getTime()) {
    throw new HttpError(409, 'Đợt đã bắt đầu, không thể đổi startTime');
  }

  const newStart = data.startTime ?? sale.startTime;
  const newEnd = data.endTime ?? sale.endTime;
  if (newEnd <= newStart) throw new HttpError(400, 'endTime phải sau startTime');
  if (newEnd <= now) throw new HttpError(400, 'endTime phải ở tương lai');

  // Đổi khung giờ: kiểm tra lại trùng lịch cho mọi item hiện có
  const timeChanged =
    newStart.getTime() !== sale.startTime.getTime() || newEnd.getTime() !== sale.endTime.getTime();
  if (timeChanged && sale.status === 'active') {
    await assertNoOverlapWithActive(sale._id, newStart, newEnd);
  }
  if (timeChanged) {
    const items = await FlashSaleItems.find({ flashSale: sale._id }).lean();
    for (const it of items) {
      const c = await findConflict(it.variant, newStart, newEnd, sale._id);
      if (c) {
        throw new HttpError(409, `Khung giờ mới trùng với đợt "${c.saleName}" ở variant ${it.variant}`);
      }
    }
  }

  Object.assign(sale, data);
  await sale.save();
  return sale;
}

/**
 * Mỗi thời điểm chỉ được có 1 đợt giờ vàng đã công bố, để client luôn chỉ hiện đúng 1 chương trình.
 * Đợt nháp / đã hủy không tính.
 */
async function assertNoOverlapWithActive(saleId, start, end) {
  const other = await FlashSales.findOne({
    _id: { $ne: saleId },
    status: 'active',
    startTime: { $lt: end },
    endTime: { $gt: start },
  })
    .select('name code')
    .lean();
  if (other) {
    throw new HttpError(
      409,
      `Khung giờ trùng với đợt "${other.name}"${other.code ? ` (${other.code})` : ''}. Mỗi thời điểm chỉ được có 1 đợt giờ vàng`
    );
  }
}

export async function publishFlashSale(id) {
  const sale = await loadEditableSale(id);
  if (sale.status !== 'draft') throw new HttpError(409, 'Chỉ đợt nháp mới có thể công bố');
  if (sale.endTime <= new Date()) throw new HttpError(409, 'Đợt đã quá hạn, hãy cập nhật endTime');
  const count = await FlashSaleItems.countDocuments({ flashSale: sale._id, isActive: true });
  if (count === 0) throw new HttpError(400, 'Cần ít nhất 1 sản phẩm trước khi công bố');
  await assertNoOverlapWithActive(sale._id, sale.startTime, sale.endTime);
  sale.status = 'active';
  await sale.save();
  return sale;
}

export async function cancelFlashSale(id) {
  const sale = await FlashSales.findById(id);
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  if (sale.status === 'cancelled') throw new HttpError(409, 'Đợt đã bị hủy trước đó');
  sale.status = 'cancelled';
  await sale.save();
  return sale;
}

export async function endFlashSaleNow(id) {
  const sale = await FlashSales.findById(id);
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  if (phaseOf(sale) !== 'running') throw new HttpError(409, 'Chỉ có thể kết thúc sớm đợt đang diễn ra');
  sale.endTime = new Date();
  await sale.save();
  return sale;
}

/* ============================= Admin: item ============================= */

export async function addItems(saleId, inputs) {
  const sale = await loadEditableSale(saleId);
  const created = [];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < inputs.length; i++) {
    const it = inputs[i];
    try {
      const variant = await ProductVariants.findById(it.variantId).select('product isActive pricing').lean();
      if (!variant || !variant.isActive) throw new HttpError(422, 'Biến thể không tồn tại hoặc đã tắt');

      const product = await Products.findById(variant.product).select('status pricing').lean();
      if (!product || product.status !== 'active') throw new HttpError(422, 'Sản phẩm không ở trạng thái active');

      const { warning } = checkPricing(variant, product, it.flashPrice);

      const stock = await getAvailableStock(variant._id);
      if (it.quota > stock) throw new HttpError(422, `quota (${it.quota}) vượt tồn kho khả dụng (${stock})`);

      const conflict = await findConflict(variant._id, sale.startTime, sale.endTime, sale._id);
      if (conflict) throw new HttpError(409, `Trùng lịch với đợt "${conflict.saleName}"`);

      const doc = await FlashSaleItems.create({
        flashSale: sale._id,
        product: variant.product,
        variant: variant._id,
        flashPrice: it.flashPrice,
        quota: it.quota,
        limitPerUser: it.limitPerUser,
      });
      created.push(doc);
      if (warning) warnings.push({ index: i, message: warning });
    } catch (err) {
      if (err instanceof HttpError) errors.push({ index: i, message: err.message });
      else if (err.code === 11000) errors.push({ index: i, message: 'Variant này đã có trong đợt' });
      else throw err;
    }
  }
  return { created, errors, warnings };
}

export async function updateItem(saleId, itemId, data) {
  const sale = await loadEditableSale(saleId);
  const item = await FlashSaleItems.findOne({ _id: itemId, flashSale: sale._id });
  if (!item) throw new HttpError(404, 'Không tìm thấy item trong đợt');

  let warning = null;
  if (data.flashPrice !== undefined) {
    const [variant, product] = await Promise.all([
      ProductVariants.findById(item.variant).select('pricing').lean(),
      Products.findById(item.product).select('pricing').lean(),
    ]);
    ({ warning } = checkPricing(variant, product, data.flashPrice));
  }
  if (data.quota !== undefined) {
    if (data.quota < item.sold) throw new HttpError(409, `quota không được nhỏ hơn số đã bán (${item.sold})`);
    const stock = await getAvailableStock(item.variant);
    if (data.quota - item.sold > stock) {
      throw new HttpError(422, `Số còn lại (${data.quota - item.sold}) vượt tồn kho khả dụng (${stock})`);
    }
  }

  Object.assign(item, data);
  await item.save();
  return { item, warning };
}

export async function removeItem(saleId, itemId) {
  const sale = await loadEditableSale(saleId);
  const item = await FlashSaleItems.findOne({ _id: itemId, flashSale: sale._id });
  if (!item) throw new HttpError(404, 'Không tìm thấy item trong đợt');
  if (item.sold > 0) throw new HttpError(409, 'Item đã có người mua, hãy tắt (isActive=false) thay vì xóa');
  await item.deleteOne();
}

/* =============================== Public =============================== */

async function getRunningSale(now = new Date()) {
  return FlashSales.findOne({
    status: 'active',
    startTime: { $lte: now },
    endTime: { $gt: now },
  })
    .sort({ startTime: 1 })
    .lean();
}

// Đợt sắp diễn ra chỉ hiện trên trang chủ nếu bắt đầu trong vòng 7 ngày (chỉnh tùy ý)
const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Đợt hiển thị cho khách: ưu tiên đợt đang chạy; nếu không có thì lấy đợt đã công bố
 * sắp bắt đầu gần nhất (chỉ để xem, chưa mua được). Đợt nháp / đã hủy không bao giờ hiện.
 */
async function getCurrentOrUpcomingSale(now = new Date()) {
  const running = await getRunningSale(now);
  if (running) return running;

  return FlashSales.findOne({
    status: 'active',
    startTime: { $gt: now, $lte: new Date(now.getTime() + UPCOMING_WINDOW_MS) },
  })
    .sort({ startTime: 1 })
    .lean();
}

/**
 * Danh sách sản phẩm của đợt, mỗi sản phẩm 1 card
 * (variant đại diện = variant có flashPrice thấp nhất còn quota).
 * Chỉ hiển thị item: isActive, còn quota, product active, variant active.
 * Giá gốc lấy từ pricing của variant (nếu có) hoặc của product.
 */
async function queryProducts(sale, page, limit) {
  const lookupById = (Model, localField, as, project, extra = {}) => ({
    $lookup: {
      from: Model.collection.name,
      let: { ref: `$${localField}` },
      pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$ref'] }, ...extra } }, { $project: project }],
      as,
    },
  });

  const [res] = await FlashSaleItems.aggregate([
    {
      $match: {
        flashSale: sale._id,
        isActive: true,
        $expr: { $lt: ['$sold', '$quota'] },
      },
    },
    lookupById(Products, 'product', 'productDoc',
      { name: 1, slug: 1, images: 1, brand: 1, ratingAverage: 1, ratingCount: 1, 'pricing.price': 1 },
      { status: 'active' }),
    lookupById(ProductVariants, 'variant', 'variantDoc',
      { sku: 1, attributes: 1, image: 1, 'pricing.price': 1 }, { isActive: true }),
    {
      $match: {
        'productDoc.0': { $exists: true },
        'variantDoc.0': { $exists: true },
      },
    },
    { $sort: { flashPrice: 1 } },
    { $group: { _id: '$product', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = res?.total?.[0]?.count ?? 0;
  const rows = res?.data ?? [];

  // Brand: lấy qua model đã đăng ký ('Brands' - theo ref trong Products)
  const brandIds = [...new Set(rows.map((r) => r.productDoc[0].brand).filter(Boolean).map(String))];
  const brands = brandIds.length
    ? await mongoose.model('Brands').find({ _id: { $in: brandIds } }).select('name slug').lean()
    : [];
  const brandMap = new Map(brands.map((b) => [String(b._id), b]));

  const items = rows.map((r) => {
    const p = r.productDoc[0];
    const v = r.variantDoc[0];
    const basePrice = v.pricing?.price ?? p.pricing?.price ?? 0;
    const brand = p.brand ? brandMap.get(String(p.brand)) : null;
    return {
      itemId: r._id,
      productId: p._id,
      variantId: v._id,
      name: p.name,
      slug: p.slug,
      image: v.image?.url || p.images?.[0]?.url || '',
      brand: brand ? { id: brand._id, name: brand.name, slug: brand.slug } : null,
      variantAttributes: v.attributes,
      ratingAverage: p.ratingAverage,
      ratingCount: p.ratingCount,
      price: basePrice,
      flashPrice: r.flashPrice,
      // Giá gốc có thể đã đổi sau khi tạo đợt -> không để phần trăm âm / chia 0
      discountPercent: basePrice > r.flashPrice ? Math.round(((basePrice - r.flashPrice) / basePrice) * 100) : 0,
      quota: r.quota,
      sold: r.sold,
      remaining: r.quota - r.sold,
      limitPerUser: r.limitPerUser,
    };
  });

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

const saleInfo = (sale, now) => ({
  id: sale._id,
  name: sale.name,
  subtitle: sale.subtitle, // undefined thì JSON tự bỏ qua -> FE dùng mặc định
  startTime: sale.startTime,
  endTime: sale.endTime,
  phase: phaseOf(sale, now), // 'running' | 'upcoming' -> FE quyết định đếm ngược tới đâu / có cho bấm không
  serverNow: now, // frontend dùng để đếm ngược, tránh lệch đồng hồ máy khách
});

export async function getCurrentFlashSale({ page, limit }) {
  const now = new Date();
  const sale = await getCurrentOrUpcomingSale(now);
  if (!sale) return { flashSale: null, items: [], pagination: { page, limit, total: 0, totalPages: 0 } };
  const { items, pagination } = await queryProducts(sale, page, limit);
  return { flashSale: saleInfo(sale, now), items, pagination };
}

export async function getFlashSaleProducts({ saleId, page, limit }) {
  const now = new Date();
  const sale = await FlashSales.findById(saleId).lean();
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  if (!['running', 'upcoming'].includes(phaseOf(sale, now))) {
    throw new HttpError(410, 'Đợt giờ vàng đã kết thúc hoặc chưa được công bố');
  }
  const { items, pagination } = await queryProducts(sale, page, limit);
  return { flashSale: saleInfo(sale, now), items, pagination };
}

/* ====================== Dùng nội bộ khi đặt hàng ====================== */
// Các hàm dưới đây chỉ áp dụng cho đợt ĐANG CHẠY: đợt sắp diễn ra chỉ để xem, không mua được.

/** Item giờ vàng đang chạy & còn quota của variant (null nếu không có). */
export async function getRunningFlashItem(variantId, now = new Date()) {
  const sales = await FlashSales.find({
    status: 'active',
    startTime: { $lte: now },
    endTime: { $gt: now },
  })
    .select('_id')
    .lean();
  if (!sales.length) return null;
  return FlashSaleItems.findOne({
    flashSale: { $in: sales.map((s) => s._id) },
    variant: variantId,
    isActive: true,
    $expr: { $lt: ['$sold', '$quota'] },
  }).lean();
}

/**
 * Giữ suất giờ vàng cho 1 dòng đơn hàng.
 * Thứ tự: ghi purchase -> kiểm tra limitPerUser -> $inc sold atomic (sold + qty <= quota).
 * Bước nào lỗi thì gỡ purchase vừa ghi. Gọi lại cùng (order, item) sẽ trả bản ghi cũ (idempotent).
 * Ném HttpError 409 nếu vượt giới hạn mua hoặc hết suất.
 */
export async function reserveQuota({ itemId, userId, orderId, qty }, session = null) {
  const item = await FlashSaleItems.findById(itemId).session(session).lean();
  if (!item || !item.isActive) throw new HttpError(409, 'Sản phẩm không còn trong giờ vàng');

  // Đợt có thể vừa kết thúc/hủy giữa lúc giỏ hàng tính giá và lúc đặt đơn
  const now = new Date();
  const sale = await FlashSales.findById(item.flashSale).session(session).lean();
  if (!sale || sale.status !== 'active' || now < sale.startTime || now >= sale.endTime) {
    throw new HttpError(409, 'Đợt giờ vàng đã kết thúc');
  }

  let purchase;
  try {
    [purchase] = await FlashSalePurchases.create(
      [{ flashSaleItem: item._id, flashSale: item.flashSale, user: userId, order: orderId, quantity: qty, unitPrice: item.flashPrice }],
      { session }
    );
  } catch (err) {
    if (err.code === 11000) {
      return FlashSalePurchases.findOne({ flashSaleItem: item._id, order: orderId }).session(session).lean();
    }
    throw err;
  }

  const undo = () => FlashSalePurchases.deleteOne({ _id: purchase._id }, { session });

  if (item.limitPerUser > 0) {
    const [agg] = await FlashSalePurchases.aggregate([
      { $match: { flashSaleItem: item._id, user: new ObjectId(String(userId)), status: { $in: ['reserved', 'completed'] } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]).session(session);
    if ((agg?.total ?? 0) > item.limitPerUser) {
      await undo();
      throw new HttpError(409, `Mỗi khách chỉ được mua tối đa ${item.limitPerUser} sản phẩm giờ vàng này`);
    }
  }

  const updated = await FlashSaleItems.findOneAndUpdate(
    { _id: item._id, isActive: true, $expr: { $lte: [{ $add: ['$sold', qty] }, '$quota'] } },
    { $inc: { sold: qty } },
    { new: true, session }
  );
  if (!updated) {
    await undo();
    throw new HttpError(409, 'Sản phẩm giờ vàng đã hết suất');
  }
  return purchase;
}

/** Hoàn suất khi hủy đơn / hết hạn thanh toán. Idempotent: gọi nhiều lần chỉ hoàn một lần. */
export async function releaseQuotaByOrder(orderId, session = null) {
  const purchases = await FlashSalePurchases.find({ order: orderId, status: 'reserved' }).session(session);
  for (const p of purchases) {
    const flipped = await FlashSalePurchases.findOneAndUpdate(
      { _id: p._id, status: 'reserved' },
      { $set: { status: 'released' } },
      { session }
    );
    if (flipped) {
      await FlashSaleItems.updateOne({ _id: p.flashSaleItem, sold: { $gte: p.quantity } }, { $inc: { sold: -p.quantity } }, { session });
    }
  }
}

/** Đơn hoàn tất: chốt các suất đã giữ (không còn hoàn lại được). */
export async function completePurchasesByOrder(orderId, session = null) {
  return FlashSalePurchases.updateMany({ order: orderId, status: 'reserved' }, { $set: { status: 'completed' } }, { session });
}

/**
 * Giá giờ vàng đang áp dụng cho nhiều variant cùng lúc (dùng cho giỏ hàng, tránh N+1).
 * Trả Map `${variantId}` -> { itemId, flashPrice, remaining, maxQuantity, endTime }.
 * maxQuantity = min(số suất còn lại, giới hạn/khách trừ số khách này đã mua).
 * Item hết suất hoặc khách đã dùng hết hạn mức thì không có trong Map (tính giá thường).
 *
 * ⚠️ Đổi chữ ký: trước là (variantIds, storeIds, userId, now), nay là (variantIds, userId, now).
 * Key của Map trước là `${variantId}:${storeId}`, nay chỉ là `${variantId}`.
 */
export async function getFlashPricingMap(variantIds, userId = null, now = new Date()) {
  const result = new Map();
  if (!variantIds.length) return result;

  const sales = await FlashSales.find({
    status: 'active',
    startTime: { $lte: now },
    endTime: { $gt: now },
  })
    .select('_id endTime')
    .lean();
  if (!sales.length) return result;
  const saleMap = new Map(sales.map((s) => [String(s._id), s]));

  const items = await FlashSaleItems.find({
    flashSale: { $in: sales.map((s) => s._id) },
    variant: { $in: variantIds },
    isActive: true,
    $expr: { $lt: ['$sold', '$quota'] },
  }).lean();
  if (!items.length) return result;

  const bought = new Map();
  if (userId) {
    const rows = await FlashSalePurchases.aggregate([
      {
        $match: {
          flashSaleItem: { $in: items.map((i) => i._id) },
          user: new ObjectId(String(userId)),
          status: { $in: ['reserved', 'completed'] },
        },
      },
      { $group: { _id: '$flashSaleItem', qty: { $sum: '$quantity' } } },
    ]);
    rows.forEach((r) => bought.set(String(r._id), r.qty));
  }

  for (const it of items) {
    const remaining = it.quota - it.sold;
    const userLeft = it.limitPerUser > 0 ? it.limitPerUser - (bought.get(String(it._id)) ?? 0) : remaining;
    const maxQuantity = Math.min(remaining, userLeft);
    if (maxQuantity < 1) continue;

    const k = String(it.variant);
    const current = result.get(k);
    if (current && current.flashPrice <= it.flashPrice) continue;
    result.set(k, {
      itemId: String(it._id),
      flashPrice: it.flashPrice,
      remaining,
      maxQuantity,
      endTime: saleMap.get(String(it.flashSale))?.endTime ?? null,
    });
  }
  return result;
}

/* ================= Admin: danh sách SKU có thể thêm vào đợt ================= */

/**
 * GET /admin/flash-sales/:id/available-variants?search=&page=&limit=
 * Chỉ trả các biến thể THÊM ĐƯỢC vào đợt:
 *  - sản phẩm active, biến thể active
 *  - có giá hợp lệ (giá riêng của variant hoặc kế thừa giá product)
 *  - tồn khả dụng trong kho tổng > 0
 *  - chưa nằm trong đợt này
 * Trùng lịch với đợt khác vẫn do addItems kiểm tra và báo lỗi theo từng SKU.
 */
export async function listAvailableVariants(saleId, { search = '', page = 1, limit = 50 }) {
  const sale = await FlashSales.findById(saleId).lean();
  if (!sale) throw new HttpError(404, 'Không tìm thấy đợt giờ vàng');
  const phase = phaseOf(sale);
  if (phase === 'cancelled' || phase === 'ended') {
    throw new HttpError(409, `Đợt đã ${phase === 'ended' ? 'kết thúc' : 'bị hủy'}, không thể thêm sản phẩm`);
  }

  const kw = search.trim();
  const re = kw ? new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

  const lookup = (from, as, matchExpr, extraMatch, project) => ({
    $lookup: {
      from,
      let: { ref: '$_id' },
      pipeline: [{ $match: { $expr: matchExpr, ...extraMatch } }, { $project: project }],
      as,
    },
  });

  const [res] = await ProductVariants.aggregate([
    { $match: { isActive: true } },
    // Product (chỉ active)
    {
      $lookup: {
        from: Products.collection.name,
        let: { p: '$product' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$p'] }, status: 'active' } },
          { $project: { name: 1, 'pricing.price': 1 } },
        ],
        as: 'productDoc',
      },
    },
    // Tồn kho kho tổng
    lookup(Inventory.collection.name, 'invDoc', { $eq: ['$variant', '$$ref'] }, { isActive: true },
      { quantity: 1, reservedQuantity: 1 }),
    // Đã có trong đợt này?
    lookup(FlashSaleItems.collection.name, 'inSale', { $eq: ['$variant', '$$ref'] }, { flashSale: sale._id },
      { _id: 1 }),
    {
      $addFields: {
        productName: { $arrayElemAt: ['$productDoc.name', 0] },
        basePrice: { $ifNull: ['$pricing.price', { $arrayElemAt: ['$productDoc.pricing.price', 0] }] },
        availableQuantity: {
          $max: [
            0,
            {
              $subtract: [
                { $ifNull: [{ $arrayElemAt: ['$invDoc.quantity', 0] }, 0] },
                { $ifNull: [{ $arrayElemAt: ['$invDoc.reservedQuantity', 0] }, 0] },
              ],
            },
          ],
        },
      },
    },
    {
      $match: {
        'productDoc.0': { $exists: true },
        basePrice: { $gt: 0 },
        availableQuantity: { $gt: 0 },
        'inSale.0': { $exists: false },
        ...(re ? { $or: [{ sku: re }, { barcode: re }, { productName: re }] } : {}),
      },
    },
    { $sort: { productName: 1, sku: 1 } },
    {
      $facet: {
        data: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              variantId: '$_id',
              productId: '$product',
              productName: 1,
              sku: 1,
              attributes: { $map: { input: '$attributes', as: 'a', in: { attributeName: '$$a.attributeName', value: '$$a.value' } } },
              isDefault: 1,
              image: '$image.url',
              price: '$basePrice',
              availableQuantity: 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const total = res?.total?.[0]?.count ?? 0;
  return {
    items: res?.data ?? [],
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}