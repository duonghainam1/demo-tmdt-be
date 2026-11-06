import mongoose from "mongoose";
import ProductVariants from "../../models/products/productVariantModel.js";
import Products from "../../models/products/productModel.js"; // ⚠ kiểm tra lại đường dẫn
import Attributes from "../../models/products/attributeModel.js"; // ⚠ kiểm tra lại đường dẫn
import Inventory from "../../models/inventory/inventoryModel.js";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js";
import {
  buildPriceInfo,
  resolveVariantPricing,
  normalizePricing,
  buildPricing,
  syncProductPriceRange,
  hasValidPricing,
} from "../../utils/pricing.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
const fail = (statusCode, message) => {
  throw new HttpError(statusCode, message);
};

// FormData gửi JSON dạng chuỗi; body JSON thường thì đã là object.
// undefined = client không gửi field; "null" -> null.
const parseJsonField = (raw, fieldName) => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fail(400, `${fieldName} không phải JSON hợp lệ`);
  }
};

const toBool = (v) => v === true || v === "true";

const parseWeight = (raw) => {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) fail(400, "weight không hợp lệ");
  return n;
};

// Upload ảnh trong req.file (multer memoryStorage => req.file.buffer) lên Cloudinary.
// Ghi lại publicId vào req để sendError dọn ảnh mồ côi nếu bước sau đó lỗi.
const uploadVariantImage = async (req) => {
  if (!req.file) return null;
  const result = await uploadImageToCloudinary(req.file.buffer, "variants");
  req._uploadedPublicId = result.public_id;
  return { url: result.secure_url, publicId: result.public_id };
};

// Xóa ảnh không được làm hỏng luồng chính: chỉ log lỗi
const destroyImage = async (publicId) => {
  if (!publicId) return;
  try {
    await deleteImageFromCloudinary(publicId);
  } catch (err) {
    console.error("Không xóa được ảnh Cloudinary:", publicId, err.message);
  }
};

// SKU không có thuộc tính (SKU mặc định) dùng key cố định
const buildAttributeKey = (attributes) =>
  attributes.length
    ? [...attributes]
        .map((a) => `${a.attribute}:${a.valueId}`)
        .sort()
        .join("|")
    : "default";

/**
 * Chuẩn hóa attributes từ client. Không tin attributeName / value client gửi:
 * tra lại từ model Attributes theo attribute + valueId.
 * ⚠ Giả định Attributes có `values: [{ _id, value }]` - đổi lại nếu schema khác.
 */
const resolveAttributes = async (raw) => {
  if (!Array.isArray(raw)) fail(400, "attributes phải là mảng");

  const seen = new Set();
  for (const a of raw) {
    if (!isValidId(a?.attribute) || !isValidId(a?.valueId)) {
      fail(400, "attribute hoặc valueId không hợp lệ");
    }
    if (seen.has(String(a.attribute))) {
      fail(400, "Một thuộc tính chỉ được chọn một lần trong cùng SKU");
    }
    seen.add(String(a.attribute));
  }

  const docs = await Attributes.find({ _id: { $in: [...seen] } }).lean();
  const docMap = new Map(docs.map((d) => [String(d._id), d]));

  return raw.map((a) => {
    const doc = docMap.get(String(a.attribute));
    if (!doc) return fail(400, "Thuộc tính không tồn tại");
    const val = (doc.values || []).find(
      (v) => String(v._id) === String(a.valueId),
    );
    if (!val) {
      return fail(400, `Giá trị không thuộc thuộc tính "${doc.name}"`);
    }
    return {
      attribute: doc._id,
      attributeName: doc.name,
      valueId: val._id,
      value: val.value,
    };
  });
};

const sendError = async (req, res, error, fallbackMessage) => {
  // Lỗi trước khi lưu DB => ảnh vừa upload bị mồ côi, dọn đi
  if (!req._imageCommitted) await destroyImage(req._uploadedPublicId);

  if (error?.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }
  if (error?.code === 11000) {
    const keys = Object.keys(error.keyPattern || {});
    const message = keys.includes("sku")
      ? "Mã SKU đã tồn tại"
      : "Tổ hợp thuộc tính này đã tồn tại cho sản phẩm";
    return res.status(409).json({ success: false, message });
  }
  return res
    .status(500)
    .json({ success: false, message: fallbackMessage, error: error.message });
};

/* ------------------------------------------------------------------ */
/* GET /admin/variants                                                 */
/* Trả về dạng CÂY: sản phẩm (cha) -> variants (con).                  */
/* Phân trang theo SẢN PHẨM; stats vẫn đếm theo SKU.                   */
/* ------------------------------------------------------------------ */
export const getProductVariants = async (req, res) => {
  try {
    const {
      product,
      sku,
      barcode,
      isActive,
      attribute,
      attributeValue,
      search,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = {};

    // aggregate() không tự cast string -> ObjectId nên phải cast thủ công
    if (product) {
      if (!isValidId(product)) {
        return res
          .status(400)
          .json({ success: false, message: "product không hợp lệ" });
      }
      filter.product = new mongoose.Types.ObjectId(product);
    }
    if (sku) filter.sku = { $regex: escapeRegex(sku), $options: "i" };
    if (barcode)
      filter.barcode = { $regex: escapeRegex(barcode), $options: "i" };
    if (typeof isActive !== "undefined") filter.isActive = isActive === "true";

    if (attribute) {
      if (!isValidId(attribute)) {
        return res
          .status(400)
          .json({ success: false, message: "attribute không hợp lệ" });
      }
      filter["attributes.attribute"] = new mongoose.Types.ObjectId(attribute);
    }
    if (attributeValue) {
      filter["attributes.value"] = {
        $regex: escapeRegex(attributeValue),
        $options: "i",
      };
    }

    // Tìm theo SKU / barcode / tên sản phẩm
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const productIds = await Products.find({ name: re }).distinct("_id");
      filter.$or = [
        { sku: re },
        { barcode: re },
        { product: { $in: productIds } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    // Chỉ cho sort theo field an toàn
    const SORTABLE = ["createdAt", "updatedAt", "sku"];
    const sortField = SORTABLE.includes(sortBy) ? sortBy : "createdAt";
    const dir = sortOrder === "asc" ? 1 : -1;
    const sort = { [sortField]: dir };

    // Thống kê toàn bộ SKU (không phụ thuộc bộ lọc tìm kiếm / trạng thái), chỉ theo product nếu có
    const statsFilter = product
      ? { product: new mongoose.Types.ObjectId(product) }
      : {};

    // 1) Phân trang theo SẢN PHẨM: nhóm SKU theo product rồi cắt trang
    const [pageAgg, statsTotal, statsActive] = await Promise.all([
      ProductVariants.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$product",
            sortValue: { [dir === 1 ? "$min" : "$max"]: `$${sortField}` },
          },
        },
        { $sort: { sortValue: dir, _id: 1 } },
        {
          $facet: {
            data: [{ $skip: skip }, { $limit: limitNum }],
            total: [{ $count: "count" }],
          },
        },
      ]),
      ProductVariants.countDocuments(statsFilter),
      ProductVariants.countDocuments({ ...statsFilter, isActive: true }),
    ]);

    const pageProductIds = pageAgg[0].data.map((g) => g._id);
    const total = pageAgg[0].total[0]?.count || 0;

    // 2) Lấy các SKU (thỏa filter) của những sản phẩm nằm trong trang này
    const items = await ProductVariants.find({
      $and: [filter, { product: { $in: pageProductIds } }],
    })
      .populate("product", "name slug category brand status pricing")
      .populate("attributes.attribute", "name code")
      .sort(sort)
      .lean();

    // Tồn kho kho tổng cho các SKU này (1 query)
    const invDocs = await Inventory.find({
      variant: { $in: items.map((v) => v._id) },
    })
      .select("variant quantity reservedQuantity")
      .lean();
    const invMap = new Map(invDocs.map((i) => [String(i.variant), i]));

    // 3) Gom nhóm: sản phẩm (cha) -> variants (con)
    const now = new Date();
    const map = new Map();

    for (const v of items) {
      if (!v.product) continue; // sản phẩm đã bị xóa hẳn

      const { pricing, inherited } = resolveVariantPricing(v, v.product);
      const inv = invMap.get(String(v._id));
      const quantity = inv?.quantity ?? 0;
      const reservedQuantity = inv?.reservedQuantity ?? 0;

      const child = {
        ...v, // giữ cả `product` để form sửa SKU dùng được
        // Admin xem được cả giá vốn
        priceInfo: {
          ...buildPriceInfo(pricing, now),
          costPrice: pricing?.costPrice ?? 0,
          inheritedFromProduct: inherited,
          missingPricing: !hasValidPricing(pricing), // để admin UI cảnh báo "chưa có giá"
        },
        inventory: {
          quantity,
          reservedQuantity,
          availableQuantity: Math.max(0, quantity - reservedQuantity),
        },
      };

      const key = String(v.product._id);
      if (!map.has(key)) {
        // Dòng cha không cần pricing của sản phẩm
        const { pricing: _omit, ...productInfo } = v.product;
        map.set(key, {
          ...productInfo,
          variantCount: 0,
          activeCount: 0,
          variants: [],
        });
      }

      const parent = map.get(key);
      parent.variants.push(child);
      parent.variantCount += 1;
      if (v.isActive) parent.activeCount += 1;
    }

    // Giữ đúng thứ tự phân trang
    const data = pageProductIds
      .map((id) => map.get(String(id)))
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      data,
      stats: {
        total: statsTotal,
        active: statsActive,
        inactive: statsTotal - statsActive,
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total, // tổng số SẢN PHẨM (không phải số SKU)
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Lỗi khi lấy danh sách SKU / Variant",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------------ */
/* POST /admin/variants  (multipart/form-data, field ảnh: "image")     */
/* body: product, sku, barcode, weight, isActive, attributes (JSON),   */
/*       pricing (JSON, tùy chọn - không gửi = kế thừa giá sản phẩm)   */
/* ------------------------------------------------------------------ */
export const createProductVariant = async (req, res) => {
  try {
    const { product: productId } = req.body;
    if (!isValidId(productId)) fail(400, "product không hợp lệ");

    const product = await Products.findOne({
      _id: productId,
      deletedAt: null,
    }).select("_id");
    if (!product) fail(404, "Không tìm thấy sản phẩm");

    const sku = String(req.body.sku || "")
      .trim()
      .toUpperCase();
    if (!sku) fail(400, "Vui lòng nhập mã SKU");

    const attributes = await resolveAttributes(
      parseJsonField(req.body.attributes, "attributes") ?? [],
    );
    if (attributes.length === 0) {
      fail(400, "Cần ít nhất 1 thuộc tính (VD: Màu sắc: Đen)");
    }

    const normalized = normalizePricing(
      parseJsonField(req.body.pricing, "pricing"),
      `Biến thể ${sku}`,
    );

    const variant = new ProductVariants({
      product: product._id,
      sku,
      attributes,
      attributeKey: buildAttributeKey(attributes),
      barcode: String(req.body.barcode || "").trim(),
      weight: parseWeight(req.body.weight),
      isActive:
        req.body.isActive === undefined ? true : toBool(req.body.isActive),
      isDefault: false,
    });
    const image = await uploadVariantImage(req);
    if (image) variant.image = image;
    if (normalized) {
      variant.pricing = buildPricing(normalized, null, req.body.note || "");
    }

    await variant.save();
    req._imageCommitted = true;

    // Sản phẩm giờ có biến thể thật: ngưng SKU mặc định (giữ lại dữ liệu/tồn kho cũ)
    await ProductVariants.updateMany(
      { product: product._id, isDefault: true },
      { $set: { isActive: false } },
    );
    await Products.updateOne(
      { _id: product._id },
      {
        $set: { hasVariants: true },
        $addToSet: {
          variantAttributes: { $each: attributes.map((a) => a.attribute) },
        },
      },
    );
    await syncProductPriceRange(product._id);

    return res.status(201).json({
      success: true,
      message: "Thêm biến thể thành công",
      data: variant,
    });
  } catch (error) {
    return sendError(req, res, error, "Lỗi khi tạo biến thể");
  }
};

/* ------------------------------------------------------------------ */
/* PUT /admin/variants/:variantId  (multipart/form-data)               */
/* Field nào không gửi thì giữ nguyên.                                 */
/* pricing: không gửi = giữ nguyên | "null" = bỏ giá riêng | object    */
/* ------------------------------------------------------------------ */
export const updateProductVariant = async (req, res) => {
  try {
    const { variantId } = req.params;
    if (!isValidId(variantId)) fail(400, "variantId không hợp lệ");

    const variant = await ProductVariants.findById(variantId);
    if (!variant) fail(404, "Không tìm thấy biến thể");

    const wasActive = variant.isActive;
    let priceTouched = false;
    let newAttributes = null;
    const oldImagePublicId = variant.image?.publicId;

    if (req.body.sku !== undefined) {
      const sku = String(req.body.sku).trim().toUpperCase();
      if (!sku) fail(400, "Mã SKU không được để trống");
      variant.sku = sku;
    }
    if (req.body.barcode !== undefined) {
      variant.barcode = String(req.body.barcode).trim();
    }
    if (req.body.weight !== undefined) {
      variant.weight = parseWeight(req.body.weight);
    }
    if (req.body.isActive !== undefined) {
      variant.isActive = toBool(req.body.isActive);
    }

    // SKU mặc định không có thuộc tính => bỏ qua attributes
    const rawAttributes = parseJsonField(req.body.attributes, "attributes");
    if (rawAttributes !== undefined && !variant.isDefault) {
      newAttributes = await resolveAttributes(rawAttributes);
      if (newAttributes.length === 0) {
        fail(400, "Cần ít nhất 1 thuộc tính (VD: Màu sắc: Đen)");
      }
      variant.attributes = newAttributes;
      variant.attributeKey = buildAttributeKey(newAttributes);
    }

    const rawPricing = parseJsonField(req.body.pricing, "pricing");
    if (rawPricing !== undefined) {
      const normalized = normalizePricing(
        rawPricing,
        `Biến thể ${variant.sku}`,
      );
      if (normalized) {
        const prev = variant.pricing ? variant.pricing.toObject() : null;
        variant.pricing = buildPricing(normalized, prev, req.body.note || "");
      } else {
        variant.pricing = undefined; // quay về kế thừa giá sản phẩm
      }
      priceTouched = true;
    }

    const image = await uploadVariantImage(req);
    if (image) variant.image = image;

    await variant.save();
    req._imageCommitted = true;

    // Dọn ảnh cũ sau khi lưu thành công
    if (image && oldImagePublicId && oldImagePublicId !== image.publicId) {
      await destroyImage(oldImagePublicId);
    }

    if (newAttributes) {
      await Products.updateOne(
        { _id: variant.product },
        {
          $addToSet: {
            variantAttributes: {
              $each: newAttributes.map((a) => a.attribute),
            },
          },
        },
      );
    }
    if (priceTouched || wasActive !== variant.isActive) {
      await syncProductPriceRange(variant.product);
    }

    return res.status(200).json({
      success: true,
      message: "Cập nhật biến thể thành công",
      data: variant,
    });
  } catch (error) {
    return sendError(req, res, error, "Lỗi khi cập nhật biến thể");
  }
};

/**
 * PUT /admin/variants/:variantId/pricing
 * body: { pricing: { price, compareAtPrice, costPrice, salePrice, saleStartDate, saleEndDate } | null, note? }
 * - pricing null / không có price  -> bỏ giá riêng, biến thể kế thừa giá sản phẩm.
 * Giá của chính SẢN PHẨM được sửa qua updateProduct.
 */
export const updateVariantPricing = async (req, res) => {
  try {
    const { variantId } = req.params;
    if (!isValidId(variantId)) {
      return res
        .status(400)
        .json({ success: false, message: "variantId không hợp lệ" });
    }

    const variant = await ProductVariants.findById(variantId);
    if (!variant) {
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy biến thể" });
    }

    const normalized = normalizePricing(
      req.body?.pricing,
      `Biến thể ${variant.sku}`,
    );

    if (normalized) {
      const prev = variant.pricing ? variant.pricing.toObject() : null;
      variant.pricing = buildPricing(normalized, prev, req.body?.note || "");
    } else {
      variant.pricing = undefined; // quay về kế thừa giá sản phẩm
    }
    await variant.save();

    await syncProductPriceRange(variant.product);

    return res.status(200).json({
      success: true,
      message: normalized
        ? "Cập nhật giá biến thể thành công"
        : "Biến thể đã quay về dùng giá sản phẩm",
      data: variant,
    });
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({
      success: false,
      message: "Lỗi khi cập nhật giá biến thể",
      error: error.message,
    });
  }
};

/* ------------------------------------------------------------------ */
/* DELETE /admin/variants/:variantId                                   */
/* ------------------------------------------------------------------ */
export const deleteProductVariant = async (req, res) => {
  try {
    const { variantId } = req.params;
    if (!isValidId(variantId)) fail(400, "variantId không hợp lệ");

    const variant = await ProductVariants.findById(variantId);
    if (!variant) fail(404, "Không tìm thấy biến thể");

    if (variant.isDefault) {
      fail(400, "Không thể xóa SKU mặc định của sản phẩm");
    }

    const siblings = await ProductVariants.countDocuments({
      product: variant.product,
      _id: { $ne: variant._id },
    });
    if (siblings === 0) {
      fail(400, "Không thể xóa SKU cuối cùng của sản phẩm");
    }

    const hasStock = await Inventory.exists({
      variant: variant._id,
      $or: [{ quantity: { $gt: 0 } }, { reservedQuantity: { $gt: 0 } }],
    });
    if (hasStock) {
      fail(
        409,
        "SKU đang có tồn kho hoặc hàng đang giữ chỗ, hãy chuyển sang Ngưng hoạt động thay vì xóa",
      );
    }

    // TODO: chặn xóa nếu SKU đã nằm trong đơn hàng / giỏ hàng (tùy model Order của bạn)

    await Inventory.deleteMany({ variant: variant._id });
    await variant.deleteOne();
    await destroyImage(variant.image?.publicId);
    await syncProductPriceRange(variant.product);

    return res.status(200).json({ success: true, message: "Đã xóa biến thể" });
  } catch (error) {
    return sendError(req, res, error, "Lỗi khi xóa biến thể");
  }
};