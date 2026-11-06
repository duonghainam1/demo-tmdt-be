
import Product from "../../models/products/productModel.js";
import ProductVariant from "../../models/products/productVariantModel.js";
import Categorys from "../../models/categories/categoryModel.js";
import mongoose from "mongoose";

const toInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GET /vouchers/options/products?search=&page=1&limit=20
 * -> { success, data: [{ value, label, status, image }], pagination: { page, limit, hasMore } }
 */
const getProductOptions = async (req, res) => {
  try {
    const page = toInt(req.query.page, 1, 1, 1e6);
    const limit = toInt(req.query.limit, 20, 1, 50); // chặn tối đa 50
    const search = (req.query.search || '').trim();

    const filter = { deletedAt: null };
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      const idsBySku = await ProductVariant.find({ sku: re }).distinct('product');
      filter.$or = [{ name: re }, { slug: re }, { _id: { $in: idsBySku } }];
      if (/^[a-f\d]{24}$/i.test(search)) filter.$or.push({ _id: search });
    }

    // Lấy dư 1 bản ghi để biết còn trang sau, không cần countDocuments
    const rows = await Product.find(filter)
      .sort({ name: 1, _id: 1 }) // thêm _id để thứ tự ổn định khi cuộn
      .collation({ locale: 'vi', strength: 2 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .select('name status images')
      .lean();

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((p) => ({
      value: p._id,
      label: p.name,
      status: p.status,
      image: p.images?.[0]?.url || '',
    }));

    return res.json({ success: true, data, pagination: { page, limit, hasMore } });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * GET /vouchers/options/categories?search=&parent=&page=1&limit=20
 * - Không có search: trả các con trực tiếp của `parent` (bỏ trống = danh mục gốc), kèm hasChildren
 * - Có search: trả danh sách phẳng toàn bộ danh mục khớp tên, kèm path "Cha › Con"
 */
const getCategoryOptions = async (req, res) => {
  try {
    const page = toInt(req.query.page, 1, 1, 1e6);
    const limit = toInt(req.query.limit, 20, 1, 50);
    const search = (req.query.search || '').trim();
    const { parent } = req.query;

    const filter = {};
    if (search) {
      filter.name = new RegExp(escapeRegex(search), 'i');
    } else {
      if (parent && !mongoose.isValidObjectId(parent)) {
        return res.status(400).json({ success: false, message: 'Danh mục cha không hợp lệ' });
      }
      filter.parent = parent || null;
    }

    const rows = await Categorys.find(filter)
      .sort({ sortOrder: 1, name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .select('name parent isActive')
      .lean();

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    // Mục nào có con -> UI hiện mũi tên mở nhánh
    const parentsWithChildren = await Categorys.distinct('parent', {
      parent: { $in: items.map((c) => c._id) },
    });
    const withChildren = new Set(parentsWithChildren.map(String));

    // Khi tìm kiếm: dựng đường dẫn từ toàn bộ danh mục (vài trăm bản ghi nhỏ, rẻ)
    let pathOf = () => '';
    if (search) {
      const all = await Categorys.find({}).select('name parent').lean();
      const byId = new Map(all.map((c) => [String(c._id), c]));
      pathOf = (c) => {
        const parts = [];
        let cur = c.parent && byId.get(String(c.parent));
        for (let i = 0; cur && i < 10; i++) {
          parts.unshift(cur.name);
          cur = cur.parent && byId.get(String(cur.parent));
        }
        return parts.join(' › ');
      };
    }

    const data = items.map((c) => ({
      value: c._id,
      label: c.name,
      isActive: c.isActive,
      hasChildren: withChildren.has(String(c._id)),
      path: pathOf(c),
    }));

    return res.json({ success: true, data, pagination: { page, limit, hasMore } });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export { getProductOptions, getCategoryOptions };
