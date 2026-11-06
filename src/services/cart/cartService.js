import mongoose from 'mongoose';
import Carts from '../../models/cart/cartModel.js';
import Products from '../../models/products/productModel.js';
import ProductVariants from '../../models/products/productVariantModel.js';
import Inventory from '../../models/inventory/inventoryModel.js'; // chỉnh đường dẫn cho đúng dự án
import { buildVariantPriceInfo, hasValidPricing } from '../../utils/pricing.js';
import { HttpError } from '../../utils/httpError.js';
import { getFlashPricingMap } from '../flashSales/flashSaleService.js'; // chỉnh đường dẫn cho đúng dự án
import { validateVoucher } from '../voucher/voucherService.js'; // chỉnh đường dẫn cho đúng dự án

/* ------------------------------ cấu hình ------------------------------ */
const MAX_QUANTITY = 99;

// Phí vận chuyển KHÔNG tính trên website: khách trả trực tiếp cho đơn vị vận chuyển khi nhận hàng.
// Giỏ hàng chỉ tính tiền hàng và giảm giá.

// Loại voucher được coi là freeship (shop trả toàn bộ phí vận chuyển, voucher không giảm tiền hàng).
// ⚠️ Đối chiếu với model voucher thật của dự án rồi chỉnh tên field / giá trị cho khớp.
const FREESHIP_TYPES = ['freeship', 'free_ship', 'free_shipping', 'shipping', 'shipping_discount'];
const isFreeShipVoucher = (v) => {
  if (!v) return false;
  if (typeof v.freeShip === 'boolean') return v.freeShip;
  const kind = String(v.type ?? v.discountType ?? v.voucherType ?? v.kind ?? '').toLowerCase();
  return FREESHIP_TYPES.includes(kind);
};

// HttpError nay nằm ở utils/HttpError.js; re-export để các file cũ chưa sửa import vẫn chạy
export { HttpError };

/* ------------------------------ helper ------------------------------ */
/**
 * Tra giá giờ vàng nhưng KHÔNG để lỗi ở module giờ vàng làm hỏng giỏ hàng.
 * Lỗi -> ghi log và coi như không có giá giờ vàng (dùng giá thường).
 * Trả về Map(variantId -> thông tin giờ vàng).
 */
const safeFlashMap = async (variantIds, userId) => {
  try {
    return await getFlashPricingMap(variantIds, userId);
  } catch (err) {
    console.error('[cart] flash pricing lookup failed:', err.message);
    return new Map();
  }
};

const assertObjectId = (value, name) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new HttpError(400, `${name} không hợp lệ`, 'INVALID_ID');
  }
};

const parseQuantity = (value) => {
  const q = Number(value);
  if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
    throw new HttpError(400, `Số lượng phải là số nguyên từ 1 đến ${MAX_QUANTITY}`, 'INVALID_QUANTITY');
  }
  return q;
};

/**
 * Tồn kho khả dụng theo TỪNG BIẾN THỂ (kho duy nhất).
 * Khả dụng = quantity - reservedQuantity. Bản ghi bị tắt (isActive: false) hoặc
 * không tồn tại thì coi như không có hàng. Nếu 1 biến thể có nhiều bản ghi kho thì cộng dồn.
 * Trả về Map(variantId -> số lượng khả dụng).
 */
const getStockMap = async (variantIds) => {
  const rows = await Inventory.find({ variant: { $in: variantIds }, isActive: true })
    .select('variant quantity reservedQuantity')
    .lean();

  const map = new Map();
  rows.forEach((r) => {
    const k = String(r.variant);
    const available = Math.max(0, (r.quantity || 0) - (r.reservedQuantity || 0));
    map.set(k, (map.get(k) || 0) + available);
  });
  return map;
};

/**
 * Giá hiệu lực hiện tại (đã tính khuyến mãi thường), có tính thêm giá giờ vàng nếu đang áp dụng.
 * Dùng để ghi priceWhenAdded cho khớp với giá hiển thị trong giỏ (tránh báo "giá đã đổi" oan).
 */
const effectivePriceNow = async (info, variantId, userId) => {
  const regular = info.effectivePrice;
  const flashMap = await safeFlashMap([variantId], userId);
  const flash = flashMap.get(String(variantId));
  return flash && flash.flashPrice < regular ? flash.flashPrice : regular;
};

/**
 * Kiểm tra biến thể có đang bán được không, trả về dữ liệu liên quan.
 * Dùng khi THÊM / ĐỔI phân loại / ĐỔI số lượng.
 * Giá lấy từ biến thể (nếu có giá riêng) hoặc kế thừa từ sản phẩm; tồn kho lấy từ kho duy nhất.
 */
const getSellable = async (variantId) => {
  assertObjectId(variantId, 'variantId');

  const variant = await ProductVariants.findById(variantId).lean();
  if (!variant || !variant.isActive) {
    throw new HttpError(404, 'Phân loại sản phẩm không tồn tại hoặc đã ngừng bán', 'VARIANT_UNAVAILABLE');
  }

  const product = await Products.findById(variant.product).lean();
  if (!product || product.status !== 'active') {
    throw new HttpError(404, 'Sản phẩm không tồn tại hoặc đã ngừng bán', 'PRODUCT_UNAVAILABLE');
  }

  // Product bắt buộc có giá; variant không có giá riêng sẽ kế thừa giá product
  if (!hasValidPricing(product.pricing)) {
    throw new HttpError(400, 'Sản phẩm chưa có giá bán', 'NOT_FOR_SALE');
  }
  const info = buildVariantPriceInfo(variant, product, new Date());

  const stockMap = await getStockMap([variant._id]);
  const stock = stockMap.get(String(variant._id)) ?? 0;

  return { variant, product, info, stock };
};

/**
 * Tính tiền giảm của voucher đang gắn trong giỏ, dựa trên các dòng được tick và mua được.
 * Giá lấy từ dữ liệu đã dựng từ DB (unitPrice, đã gồm giá giờ vàng), KHÔNG tin client.
 *
 * Phí vận chuyển không tính trên website (shippingFee = 0) nên:
 *  - Voucher giảm giá thường: giảm trên tiền hàng như bình thường.
 *  - Voucher freeship: discountAmount luôn = 0, chỉ bật cờ voucher.freeShip = true
 *    (shop trả toàn bộ phí vận chuyển, khách không phải trả thêm khi nhận hàng).
 *
 * Lỗi nghiệp vụ (hết hạn, chưa đủ đơn tối thiểu, hết lượt...) KHÔNG làm hỏng giỏ:
 * trả discount = 0 và voucher.error để FE hiển thị cho khách.
 * Mã công khai (public_code) dùng được mà không cần có trong ví; loại claimable / assigned
 * thì validateVoucher yêu cầu có trong ví.
 */
const computeVoucher = async (cart, payable) => {
  if (!cart.voucherCode) return { discount: 0, voucher: null };

  const voucher = { code: cart.voucherCode, title: null, discountAmount: 0, freeShip: false, error: null };

  if (payable.length === 0) {
    voucher.error = 'Hãy chọn sản phẩm để áp dụng voucher';
    return { discount: 0, voucher };
  }

  try {
    const voucherCart = {
      items: payable.map((i) => ({
        product: i.productId,
        category: i.categoryId,
        price: i.unitPrice,
        quantity: i.quantity,
      })),
      shippingFee: 0, // không tính phí ship trên website
    };
    const res = await validateVoucher(cart.voucherCode, cart.user, voucherCart);
    voucher.title = res.voucher.displayTitle;
    voucher.freeShip = isFreeShipVoucher(res.voucher);

    // Voucher freeship không giảm tiền hàng
    voucher.discountAmount = voucher.freeShip ? 0 : res.discountAmount;
    return { discount: voucher.discountAmount, voucher };
  } catch (err) {
    if (err.status) {
      voucher.error = err.message; // lỗi nghiệp vụ: hiện cho khách
    } else {
      console.error('[cart] voucher check failed:', err.message);
      voucher.error = 'Không kiểm tra được voucher, vui lòng thử lại';
    }
    return { discount: 0, voucher };
  }
};

/* ------------------------------ dựng dữ liệu trả về ------------------------------ */
const emptyView = () => ({
  items: [],
  voucher: null,
  summary: {
    itemCount: 0,
    selectedCount: 0,
    allSelected: false,
    subtotal: 0,
    discount: 0,
    total: 0, // tổng tiền hàng (chưa gồm phí vận chuyển)
  },
});

/**
 * Chuyển giỏ hàng (chỉ chứa id) thành dữ liệu đầy đủ cho FE:
 * tên, ảnh, giá hiệu lực, tồn kho, cảnh báo, các phân loại có thể đổi sang.
 *
 * Giá giờ vàng: dòng nào có item giờ vàng đang chạy, còn suất, khách còn hạn mức và
 * flashPrice < giá thường thì unitPrice = flashPrice (isFlashSale = true).
 * Nếu số lượng trong giỏ vượt flashMaxQuantity thì gắn issue FLASH_LIMIT (chặn thanh toán
 * cho tới khi khách giảm số lượng).
 *
 * Voucher: giỏ chỉ lưu mã (cart.voucherCode), tiền giảm được tính lại ở đây mỗi lần lấy giỏ
 * nên luôn khớp với sản phẩm đang tick, số lượng và giá hiện tại.
 */
export const buildCartView = async (cart) => {
  if (!cart || cart.items.length === 0) return emptyView();

  const productIds = [...new Set(cart.items.map((i) => String(i.product)))];
  const variantIds = [...new Set(cart.items.map((i) => String(i.variant)))];

  const [products, variants, siblingVariants, flashMap] = await Promise.all([
    Products.find({ _id: { $in: productIds } })
      .select('name slug images brand status pricing category') // category để voucher lọc theo danh mục
      .populate('brand', 'name slug')
      .lean(),
    ProductVariants.find({ _id: { $in: variantIds } }).lean(),
    // các phân loại khác của cùng sản phẩm đang bán -> để FE cho đổi phân loại
    ProductVariants.find({ product: { $in: productIds }, isActive: true })
      .select('product attributes')
      .lean(),
    safeFlashMap(variantIds, cart.user),
  ]);

  const stockMap = await getStockMap([...new Set([...variantIds, ...siblingVariants.map((v) => String(v._id))])]);

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const variantMap = new Map(variants.map((v) => [String(v._id), v]));

  const optionsMap = new Map(); // productId -> [{ variantId, attributes, label, available }]
  siblingVariants.forEach((sv) => {
    const k = String(sv.product);
    if (!optionsMap.has(k)) optionsMap.set(k, []);
    optionsMap.get(k).push({
      variantId: String(sv._id),
      attributes: (sv.attributes || []).map((a) => ({ name: a.attributeName, value: a.value })),
      label: (sv.attributes || []).map((a) => a.value).join(' / '),
      available: (stockMap.get(String(sv._id)) ?? 0) > 0,
    });
  });

  const now = new Date();

  const items = cart.items.map((item) => {
    const product = productMap.get(String(item.product));
    const variant = variantMap.get(String(item.variant));
    const stock = stockMap.get(String(item.variant)) ?? 0;

    // Giá của biến thể (đã kế thừa từ product nếu không có giá riêng)
    const info =
      product && variant && hasValidPricing(variant.pricing?.price != null ? variant.pricing : product.pricing)
        ? buildVariantPriceInfo(variant, product, now)
        : null;
    const regularPrice = info ? info.effectivePrice : null;

    // Giá giờ vàng chỉ áp dụng khi thấp hơn giá thường hiện hành
    const flash = flashMap.get(String(item.variant));
    const useFlash = Boolean(flash && regularPrice != null && flash.flashPrice < regularPrice);
    const unitPrice = useFlash ? flash.flashPrice : regularPrice;

    const issues = [];
    if (!product || product.status !== 'active') issues.push('PRODUCT_UNAVAILABLE');
    if (!variant || !variant.isActive) issues.push('VARIANT_UNAVAILABLE');
    if (!info) issues.push('NOT_FOR_SALE');
    if (stock <= 0) issues.push('OUT_OF_STOCK');
    else if (item.quantity > stock) issues.push('INSUFFICIENT_STOCK');
    if (useFlash && item.quantity > flash.maxQuantity) issues.push('FLASH_LIMIT');

    const isPurchasable = issues.length === 0;

    return {
      id: String(item._id),
      productId: String(item.product),
      categoryId: product?.category ? String(product.category) : null, // dùng cho voucher theo danh mục
      variantId: String(item.variant),
      sku: variant?.sku ?? '',
      slug: product?.slug ?? null,
      brand: product?.brand?.name ?? '',
      name: product?.name ?? 'Sản phẩm không còn tồn tại',
      image: variant?.image?.url || product?.images?.[0]?.url || '',
      attributes: (variant?.attributes ?? []).map((a) => ({ name: a.attributeName, value: a.value })),
      options: optionsMap.get(String(item.product)) ?? [],

      quantity: item.quantity,
      selected: item.selected,
      stock,

      unitPrice,
      originalPrice: info ? info.originalPrice : null,
      isSale: info ? info.isSale || useFlash : false,
      lineTotal: isPurchasable && unitPrice != null ? unitPrice * item.quantity : 0,
      priceChanged:
        item.priceWhenAdded != null && unitPrice != null && unitPrice !== item.priceWhenAdded,

      // Giờ vàng
      isFlashSale: useFlash,
      flashItemId: useFlash ? flash.itemId : null,
      flashMaxQuantity: useFlash ? flash.maxQuantity : null,
      flashRemaining: useFlash ? flash.remaining : null,
      flashEndTime: useFlash ? flash.endTime : null,

      issues,
      isPurchasable,
    };
  });

  // Chỉ tính tiền các dòng được tick VÀ đang mua được
  const payable = items.filter((i) => i.selected && i.isPurchasable);
  const subtotal = payable.reduce((sum, i) => sum + i.lineTotal, 0);

  const { discount, voucher } = await computeVoucher(cart, payable);

  return {
    items,
    voucher, // null nếu giỏ chưa gắn voucher; có voucher.error nếu mã không còn hợp lệ; voucher.freeShip = true nếu là voucher freeship
    summary: {
      itemCount: items.length,
      selectedCount: items.filter((i) => i.selected).length,
      allSelected: items.every((i) => i.selected),
      subtotal,
      discount,
      total: Math.max(0, subtotal - discount), // tổng tiền hàng, chưa gồm phí vận chuyển
    },
  };
};

/* ------------------------------ nghiệp vụ ------------------------------ */
export const getCart = async (userId) => {
  const cart = await Carts.findOne({ user: userId });
  return buildCartView(cart);
};

export const addItem = async (userId, { variantId, quantity = 1 }) => {
  const qty = parseQuantity(quantity);
  const { variant, info, stock } = await getSellable(variantId);

  const cart = await Carts.findOrCreateByUser(userId);
  const existing = cart.findItem(variant._id);
  const nextQty = (existing?.quantity ?? 0) + qty;

  if (stock <= 0) {
    throw new HttpError(409, 'Sản phẩm đã hết hàng', 'OUT_OF_STOCK');
  }
  if (nextQty > MAX_QUANTITY) {
    throw new HttpError(400, `Mỗi sản phẩm tối đa ${MAX_QUANTITY} trong giỏ`, 'MAX_QUANTITY');
  }
  if (nextQty > stock) {
    throw new HttpError(409, `Chỉ còn ${stock} sản phẩm trong kho`, 'INSUFFICIENT_STOCK');
  }

  try {
    cart.addItem({
      product: variant.product,
      variant: variant._id,
      quantity: qty,
      priceWhenAdded: await effectivePriceNow(info, variant._id, userId),
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  await cart.save();
  return buildCartView(cart);
};

/**
 * Cập nhật 1 dòng: đổi số lượng, tick chọn, hoặc đổi phân loại (variantId mới).
 */
export const updateItem = async (userId, itemId, { quantity, selected, variantId } = {}) => {
  assertObjectId(itemId, 'itemId');

  const cart = await Carts.findOne({ user: userId });
  const item = cart?.items.id(itemId);
  if (!item) throw new HttpError(404, 'Không tìm thấy sản phẩm trong giỏ hàng', 'ITEM_NOT_FOUND');

  let sellable = null;
  const variantChanged = variantId !== undefined && String(variantId) !== String(item.variant);

  if (variantChanged) {
    sellable = await getSellable(variantId);

    if (String(sellable.variant.product) !== String(item.product)) {
      throw new HttpError(400, 'Phân loại mới không thuộc sản phẩm này', 'VARIANT_MISMATCH');
    }

    // Đã có dòng cùng phân loại mới -> gộp số lượng rồi xoá dòng cũ
    const duplicate = cart.findItem(variantId);
    if (duplicate) {
      const merged = Math.min(MAX_QUANTITY, duplicate.quantity + (quantity ?? item.quantity));
      if (merged > sellable.stock) {
        throw new HttpError(409, `Chỉ còn ${sellable.stock} sản phẩm trong kho`, 'INSUFFICIENT_STOCK');
      }
      duplicate.quantity = merged;
      item.deleteOne();
      await cart.save();
      return buildCartView(cart);
    }

    item.variant = sellable.variant._id;
    item.priceWhenAdded = await effectivePriceNow(sellable.info, sellable.variant._id, userId);
  }

  if (quantity !== undefined || variantChanged) {
    const target = quantity !== undefined ? parseQuantity(quantity) : item.quantity;
    sellable ??= await getSellable(item.variant);

    if (target > sellable.stock) {
      throw new HttpError(409, `Chỉ còn ${sellable.stock} sản phẩm trong kho`, 'INSUFFICIENT_STOCK');
    }
    item.quantity = target;
  }

  if (selected !== undefined) item.selected = Boolean(selected);

  await cart.save();
  return buildCartView(cart);
};

export const setAllSelected = async (userId, selected) => {
  const cart = await Carts.findOne({ user: userId });
  if (!cart) return emptyView();

  cart.setAllSelected(selected);
  await cart.save();
  return buildCartView(cart);
};

export const removeItem = async (userId, itemId) => {
  assertObjectId(itemId, 'itemId');

  const cart = await Carts.findOne({ user: userId });
  if (!cart || !cart.removeItem(itemId)) {
    throw new HttpError(404, 'Không tìm thấy sản phẩm trong giỏ hàng', 'ITEM_NOT_FOUND');
  }

  await cart.save();
  return buildCartView(cart);
};

export const clearCart = async (userId) => {
  const cart = await Carts.findOne({ user: userId });
  if (cart) {
    cart.clear();
    await cart.save();
  }
  return emptyView();
};

/* ------------------------------ voucher ------------------------------ */
/**
 * Gắn voucher vào giỏ. Mã có thể là mã công khai (không cần có trong ví)
 * hoặc voucher trong ví của khách. Kiểm tra bằng đúng logic lúc đặt hàng (validateVoucher);
 * không hợp lệ thì ném lỗi và KHÔNG lưu, giỏ giữ nguyên voucher cũ (nếu có).
 */
export const applyVoucher = async (userId, code) => {
  const value = String(code ?? '').trim().toUpperCase();
  if (!value) throw new HttpError(400, 'Vui lòng nhập mã voucher', 'INVALID_CODE');

  const cart = await Carts.findOne({ user: userId });
  if (!cart || cart.items.length === 0) {
    throw new HttpError(400, 'Giỏ hàng đang trống', 'EMPTY_CART');
  }

  cart.voucherCode = value;
  const view = await buildCartView(cart); // tính thử, chưa save
  if (view.voucher?.error) throw new HttpError(400, view.voucher.error, 'VOUCHER_INVALID');

  await cart.save();
  return view;
};

export const removeVoucher = async (userId) => {
  const cart = await Carts.findOne({ user: userId });
  if (!cart) return emptyView();

  cart.clearVoucher();
  await cart.save();
  return buildCartView(cart);
};