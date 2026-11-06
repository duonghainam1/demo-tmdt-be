import Products from '../models/products/productModel.js';
import ProductVariants from '../models/products/productVariantModel.js';

const fail = (msg) => {
  throw Object.assign(new Error(msg), { statusCode: 400 });
};

/* ------------------------------------------------------------------ */
/* Đọc giá (dùng cho document dạng lean)                               */
/* ------------------------------------------------------------------ */
export const isSaleActive = (p, now = new Date()) =>
  !!p &&
  p.salePrice != null &&
  !!p.saleStartDate &&
  !!p.saleEndDate &&
  now >= new Date(p.saleStartDate) &&
  now <= new Date(p.saleEndDate);

/** Có pricing hợp lệ (có price là số) hay không. */
export const hasValidPricing = (p) => !!p && typeof p.price === 'number' && Number.isFinite(p.price);

/** Từ 1 object pricing -> thông tin giá để trả ra client (KHÔNG có costPrice, history). */
export const buildPriceInfo = (pricing, now = new Date()) => {
  const p = pricing || {}; // chịu được pricing undefined/null
  const price = Number(p.price) || 0;
  const compareAtPrice = Number(p.compareAtPrice) || 0;

  const saleActive = isSaleActive(p, now);
  const effectivePrice = saleActive ? p.salePrice : price;
  // Giá gạch ngang: ưu tiên compareAtPrice nếu lớn hơn giá bán thường
  const originalPrice = compareAtPrice > price ? compareAtPrice : price;
  const discountPercent =
    originalPrice > effectivePrice ? Math.round(((originalPrice - effectivePrice) / originalPrice) * 100) : 0;

  return {
    price,
    compareAtPrice,
    originalPrice,
    salePrice: p.salePrice ?? null,
    effectivePrice,
    isSale: effectivePrice < originalPrice,
    isSaleActive: saleActive,
    discountPercent,
    saleStartDate: p.saleStartDate ?? null,
    saleEndDate: p.saleEndDate ?? null,
    currency: p.currency || 'VND',
  };
};

/** Biến thể có giá riêng (pricing.price != null) thì dùng, không thì kế thừa giá product. */
export const resolveVariantPricing = (variant, product) => {
  const own = !!variant?.pricing && variant.pricing.price != null;
  return { pricing: own ? variant.pricing : product?.pricing, inherited: !own };
};

export const buildVariantPriceInfo = (variant, product, now = new Date()) => {
  const { pricing, inherited } = resolveVariantPricing(variant, product);
  return { ...buildPriceInfo(pricing, now), inheritedFromProduct: inherited };
};

/* ------------------------------------------------------------------ */
/* Ghi giá                                                             */
/* ------------------------------------------------------------------ */

/**
 * Validate + chuẩn hóa input giá từ client.
 * - required=true  (product): thiếu price -> báo lỗi.
 * - required=false (variant): thiếu price -> trả undefined (= kế thừa giá product).
 */
export const normalizePricing = (input, label, { required = false } = {}) => {
  const empty = (v) => v === undefined || v === null || v === '';

  if (!input || empty(input.price)) {
    if (required) fail(`${label}: vui lòng nhập giá bán`);
    return undefined;
  }

  const num = (v, name, def = 0) => {
    if (empty(v)) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) fail(`${label}: ${name} không hợp lệ`);
    return n;
  };

  const price = num(input.price, 'giá bán');
  const compareAtPrice = num(input.compareAtPrice, 'giá niêm yết');
  const costPrice = num(input.costPrice, 'giá vốn');
  const salePrice = empty(input.salePrice) ? null : num(input.salePrice, 'giá khuyến mãi');

  let saleStartDate = null;
  let saleEndDate = null;
  if (salePrice != null) {
    if (salePrice > price) fail(`${label}: giá khuyến mãi không được lớn hơn giá bán`);
    saleStartDate = new Date(input.saleStartDate);
    saleEndDate = new Date(input.saleEndDate);
    if (Number.isNaN(saleStartDate.getTime()) || Number.isNaN(saleEndDate.getTime()))
      fail(`${label}: cần nhập thời gian bắt đầu và kết thúc khuyến mãi`);
    if (saleEndDate <= saleStartDate) fail(`${label}: thời gian kết thúc khuyến mãi phải sau thời gian bắt đầu`);
  }

  return {
    price,
    compareAtPrice,
    costPrice,
    salePrice,
    saleStartDate,
    saleEndDate,
    currency: (input.currency || 'VND').toString().toUpperCase().trim(),
  };
};

/**
 * Gộp giá mới + lịch sử cũ. Chỉ ghi thêm 1 dòng history khi các giá trị tiền thực sự đổi.
 * @param normalized  kết quả của normalizePricing
 * @param old         pricing hiện tại (plain object) hoặc null khi tạo mới
 */
export const buildPricing = (normalized, old = null, note = '') => {
  const prev = old && old.price != null ? old : null;
  const history = [...(old?.history || [])];
  const keys = ['price', 'compareAtPrice', 'costPrice', 'salePrice'];
  const changed = !prev || keys.some((k) => (prev[k] ?? null) !== (normalized[k] ?? null));

  if (changed) {
    history.push({
      price: normalized.price,
      compareAtPrice: normalized.compareAtPrice,
      costPrice: normalized.costPrice,
      salePrice: normalized.salePrice,
      note,
      changedAt: new Date(),
    });
  }
  return { ...normalized, history };
};

/**
 * Tính lại Products.priceMin / priceMax từ giá niêm yết của product + các variant đang active.
 * GỌI SAU MỖI LẦN đổi giá product / thêm-sửa-tắt variant.
 */
export const syncProductPriceRange = async (productId, session = null) => {
  const product = await Products.findById(productId).select('pricing').session(session).lean();
  if (!product) return;

  const base = product.pricing?.price;
  if (typeof base !== 'number') return; // product thiếu giá: không sync, tránh crash

  const variants = await ProductVariants.find({ product: productId, isActive: true })
    .select('pricing')
    .session(session)
    .lean();

  const prices = variants.length ? variants.map((v) => v.pricing?.price ?? base) : [base];

  await Products.updateOne(
    { _id: productId },
    { $set: { priceMin: Math.min(...prices), priceMax: Math.max(...prices) } },
    { session }
  );
};