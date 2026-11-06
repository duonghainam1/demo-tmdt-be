import mongoose from 'mongoose';

import Inventory from '../../models/inventory/inventoryModel.js';
import InventoryTransactions from '../../models/inventory/inventoryTransactionModel.js';
import ProductVariants from '../../models/products/productVariantModel.js';
import Products from '../../models/products/productModel.js';
// TODO: đổi đường dẫn / tên model danh mục cho đúng project
import Categories from '../../models/categories/categoryModel.js';

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MAX_IMPORT_QUANTITY = 1_000_000;

// Lỗi nghiệp vụ có kèm HTTP status
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Lấy id danh mục + toàn bộ con cháu (field cha của danh mục là `parent`)
const getCategoryWithDescendants = async (rootId) => {
  const ids = new Set([String(rootId)]);
  let frontier = [new mongoose.Types.ObjectId(rootId)];

  while (frontier.length) {
    const childIds = await Categories.find({ parent: { $in: frontier } }).distinct('_id');
    frontier = childIds.filter((id) => !ids.has(String(id)));
    frontier.forEach((id) => ids.add(String(id)));
  }

  return [...ids].map((id) => new mongoose.Types.ObjectId(id));
};

// virtuals không có sẵn khi dùng .lean() => tự tính
const withComputed = (inv) => {
  const availableQuantity = Math.max(0, inv.quantity - inv.reservedQuantity);
  return {
    ...inv,
    availableQuantity,
    isLowStock: availableQuantity <= (inv.reorderLevel ?? 0),
    isOutOfStock: availableQuantity <= 0,
  };
};

// Ảnh đại diện sản phẩm: images[0] (dạng { url, publicId } hoặc chuỗi URL ở dữ liệu cũ)
const firstImageUrl = (images) => {
  const first = Array.isArray(images) ? images[0] : null;
  if (!first) return '';
  return typeof first === 'string' ? first : first.url || '';
};

// =====================================================
// GET INVENTORY (kho tổng)
// =====================================================

/**
 * GET /api/inventory
 *
 * Query:
 *   ?product=PRODUCT_ID
 *   ?variant=VARIANT_ID
 *   ?category=CATEGORY_ID   (lọc theo danh mục của sản phẩm)
 *   ?search=từ khóa        (SKU, barcode hoặc tên sản phẩm)
 *   ?stockStatus=in|low|out (còn hàng | sắp hết | hết hàng)
 *   ?isActive=true
 *   ?page=1&limit=20
 *
 * Mỗi sản phẩm (cha) trả thêm `image` (ảnh đầu tiên của sản phẩm) để FE hiển thị khi biến thể không có ảnh.
 */
export const getInventory = async (req, res) => {
  try {
    const { product, variant, category, search, stockStatus, isActive, page = 1, limit = 20 } = req.query;

    const filter = {};
    const and = [];

    if (product) {
      if (!isValidId(product)) return res.status(400).json({ message: 'product không hợp lệ' });
      filter.product = new mongoose.Types.ObjectId(product); // aggregate không tự cast
    }

    if (variant) {
      if (!isValidId(variant)) return res.status(400).json({ message: 'variant không hợp lệ' });
      filter.variant = new mongoose.Types.ObjectId(variant);
    }

    // Lọc theo danh mục: gồm cả các danh mục con (chọn cha => lấy sản phẩm của cả nhánh)
    if (category) {
      if (!isValidId(category)) return res.status(400).json({ message: 'category không hợp lệ' });
      const categoryIds = await getCategoryWithDescendants(category);
      const categoryProductIds = await Products.find({ category: { $in: categoryIds } }).distinct('_id');
      and.push({ product: { $in: categoryProductIds } });
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const keyword = (search || '').trim();
    if (keyword) {
      const re = new RegExp(escapeRegex(keyword), 'i');
      const [variantIds, productIds] = await Promise.all([
        ProductVariants.find({ $or: [{ sku: re }, { barcode: re }] }).distinct('_id'),
        Products.find({ name: re }).distinct('_id'),
      ]);
      and.push({ $or: [{ variant: { $in: variantIds } }, { product: { $in: productIds } }] });
    }

    const available = { $subtract: ['$quantity', '$reservedQuantity'] };
    if (stockStatus === 'out') {
      and.push({ $expr: { $lte: [available, 0] } });
    } else if (stockStatus === 'low') {
      and.push({ $expr: { $and: [{ $gt: [available, 0] }, { $lte: [available, '$reorderLevel'] }] } });
    } else if (stockStatus === 'in') {
      and.push({ $expr: { $gt: [available, '$reorderLevel'] } });
    } else if (stockStatus) {
      return res.status(400).json({ message: 'stockStatus không hợp lệ (in | low | out)' });
    }

    if (and.length) filter.$and = and;

    const pageNumber = Math.max(Number(page) || 1, 1);
    const limitNumber = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = (pageNumber - 1) * limitNumber;

    // 1) Phân trang theo SẢN PHẨM (nhóm các dòng tồn kho theo product)
    const [agg] = await Inventory.aggregate([
      { $match: filter },
      { $group: { _id: '$product', latestCreatedAt: { $max: '$createdAt' } } },
      { $sort: { latestCreatedAt: -1, _id: 1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limitNumber }],
          total: [{ $count: 'count' }],
        },
      },
    ]);

    const pageProductIds = agg.data.map((g) => g._id);
    const total = agg.total[0]?.count || 0;

    // 2) Lấy toàn bộ biến thể (thỏa filter) của các sản phẩm trong trang này
    //    - product: lấy thêm `images` để tính ảnh đại diện (trước đây thiếu nên FE không có ảnh sản phẩm)
    //    - variant: đã có `image`
    const rows = await Inventory.find({ $and: [filter, { product: { $in: pageProductIds } }] })
      .populate({ path: 'product', select: 'name slug status images' })
      .populate({ path: 'variant', select: 'sku attributes image barcode isActive' })
      .sort({ createdAt: 1 })
      .lean();

    // 3) Gom nhóm: sản phẩm (cha) -> variants (con)
    const map = new Map();
    for (const row of rows.map(withComputed)) {
      if (!row.product) continue; // sản phẩm đã bị xóa
      const key = String(row.product._id);

      if (!map.has(key)) {
        // Không trả cả mảng images (nặng) mà chỉ trả 1 ảnh đại diện
        const { images, ...productInfo } = row.product;
        map.set(key, {
          ...productInfo,
          image: firstImageUrl(images),
          totalQuantity: 0,
          totalReserved: 0,
          totalAvailable: 0,
          variantCount: 0,
          isLowStock: false,
          isOutOfStock: true,
          variants: [],
        });
      }

      const parent = map.get(key);
      const { product: _omit, ...child } = row; // bỏ product lặp lại trong từng con
      parent.variants.push(child);
      parent.variantCount += 1;
      parent.totalQuantity += row.quantity;
      parent.totalReserved += row.reservedQuantity;
      parent.totalAvailable += row.availableQuantity;
      parent.isLowStock = parent.isLowStock || row.isLowStock;
      parent.isOutOfStock = parent.isOutOfStock && row.isOutOfStock;
    }

    // Giữ đúng thứ tự phân trang
    const data = pageProductIds.map((id) => map.get(String(id))).filter(Boolean);

    return res.status(200).json({
      message: 'Lấy tồn kho thành công',
      data,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total, // tổng số sản phẩm
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    console.error('getInventory error:', error);
    return res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};

// =====================================================
// NHẬP KHO
// =====================================================

/**
 * POST /api/inventory/import
 *
 * Body: định danh bản ghi tồn kho bằng 1 trong 2 cách
 *   { "inventoryId": "...", "quantity": 100, "note": "Nhập hàng tháng 9" }
 *   { "variantId":   "...", "quantity": 100, "note": "..." }
 */
export const importInventory = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { inventoryId, variantId, quantity, note = '' } = req.body;

    // ---------- Validate ----------
    if (!inventoryId && !variantId) {
      return res.status(400).json({ message: 'Cần truyền inventoryId hoặc variantId' });
    }
    if (inventoryId && !isValidId(inventoryId)) {
      return res.status(400).json({ message: 'inventoryId không hợp lệ' });
    }
    if (variantId && !isValidId(variantId)) {
      return res.status(400).json({ message: 'variantId không hợp lệ' });
    }

    const importQuantity = Number(quantity);
    if (!Number.isInteger(importQuantity) || importQuantity <= 0) {
      return res.status(400).json({ message: 'quantity phải là số nguyên lớn hơn 0' });
    }
    if (importQuantity > MAX_IMPORT_QUANTITY) {
      return res.status(400).json({ message: `quantity tối đa ${MAX_IMPORT_QUANTITY} mỗi lần nhập` });
    }

    const identity = inventoryId ? { _id: inventoryId } : { variant: variantId };

    // ---------- Transaction ----------
    let result;

    await session.withTransaction(async () => {
      // $inc nguyên tử: an toàn khi 2 người nhập kho cùng lúc.
      // new:false => trả về bản ghi TRƯỚC khi cộng, dùng làm beforeQuantity.
      const before = await Inventory.findOneAndUpdate(
        { ...identity, isActive: true },
        { $inc: { quantity: importQuantity }, $set: { lastRestockedAt: new Date() } },
        { new: false, session }
      );

      if (!before) {
        // Phân biệt "không tồn tại" và "đang bị tắt"
        const exists = await Inventory.exists(identity).session(session);
        if (!exists) throw new HttpError(404, 'Không tìm thấy tồn kho của biến thể này');
        throw new HttpError(400, 'Tồn kho của biến thể này đang bị tắt');
      }

      const afterQuantity = before.quantity + importQuantity;

      const [transaction] = await InventoryTransactions.create(
        [
          {
            variant: before.variant,
            product: before.product,
            inventory: before._id,

            type: 'import',
            quantity: importQuantity,

            beforeQuantity: before.quantity,
            afterQuantity,
            beforeReservedQuantity: before.reservedQuantity,
            afterReservedQuantity: before.reservedQuantity,

            note: String(note ?? '').trim(),
            createdBy: req.user?._id || null,
          },
        ],
        { session }
      );

      result = {
        inventory: withComputed({
          ...before.toObject(),
          quantity: afterQuantity,
          lastRestockedAt: transaction.createdAt,
        }),
        transaction,
      };
    });

    return res.status(200).json({
      message: 'Nhập kho thành công',
      data: result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error('importInventory error:', error);

    return res.status(statusCode).json({
      message: statusCode === 500 ? 'Lỗi server' : error.message,
      error: statusCode === 500 ? error.message : undefined,
    });
  } finally {
    await session.endSession();
  }
};

// =====================================================
// KIỂM KHO (đối chiếu tồn hệ thống với số lượng đếm thực tế)
// =====================================================
export const stocktakeInventory = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { inventoryId, countedQuantity, expectedQuantity, note = '' } = req.body;
    if (!isValidId(inventoryId)) {
      return res.status(400).json({ message: 'inventoryId không hợp lệ' });
    }

    const counted = Number(countedQuantity);
    const expected = Number(expectedQuantity);
    if (!Number.isInteger(counted) || counted < 0 || counted > MAX_IMPORT_QUANTITY) {
      return res.status(400).json({ message: `Số lượng kiểm đếm phải là số nguyên từ 0 đến ${MAX_IMPORT_QUANTITY}` });
    }
    if (!Number.isInteger(expected) || expected < 0) {
      return res.status(400).json({ message: 'Tồn hệ thống gửi lên không hợp lệ' });
    }

    let result;
    await session.withTransaction(async () => {
      const before = await Inventory.findOne({ _id: inventoryId, isActive: true }).session(session);
      if (!before) throw new HttpError(404, 'Không tìm thấy tồn kho đang hoạt động');
      if (before.quantity !== expected) {
        throw new HttpError(409, 'Tồn kho đã thay đổi trong lúc kiểm đếm. Vui lòng tải lại và kiểm kho lại.');
      }

      const delta = counted - before.quantity;
      const after = await Inventory.findOneAndUpdate(
        { _id: before._id, isActive: true, quantity: before.quantity },
        { $set: { quantity: counted } },
        { new: true, session }
      );
      if (!after) throw new HttpError(409, 'Tồn kho vừa được cập nhật. Vui lòng kiểm kho lại.');

      const [transaction] = await InventoryTransactions.create([{
        variant: before.variant,
        product: before.product,
        inventory: before._id,
        type: 'adjust',
        quantity: delta,
        beforeQuantity: before.quantity,
        afterQuantity: counted,
        beforeReservedQuantity: before.reservedQuantity,
        afterReservedQuantity: before.reservedQuantity,
        note: String(note ?? '').trim().slice(0, 500),
        createdBy: req.user?._id || null,
      }], { session });

      result = { inventory: withComputed(after.toObject()), transaction, difference: delta };
    });

    return res.status(200).json({ message: 'Kiểm kho thành công', data: result });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 500) console.error('stocktakeInventory error:', error);
    return res.status(statusCode).json({
      message: statusCode === 500 ? 'Lỗi server' : error.message,
      error: statusCode === 500 ? error.message : undefined,
    });
  } finally {
    await session.endSession();
  }
};

export const getInventoryTransactions = async (req, res) => {
  try {
    const { inventoryId } = req.params;
    if (!isValidId(inventoryId)) return res.status(400).json({ message: 'inventoryId không hợp lệ' });

    const exists = await Inventory.exists({ _id: inventoryId });
    if (!exists) return res.status(404).json({ message: 'Không tìm thấy tồn kho' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const transactions = await InventoryTransactions.find({ inventory: inventoryId })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({ data: transactions });
  } catch (error) {
    console.error('getInventoryTransactions error:', error);
    return res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};
