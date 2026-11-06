import mongoose from 'mongoose';
import Product from '../../models/products/productModel.js';
import ProductVariant from '../../models/products/productVariantModel.js';
import Inventory from '../../models/inventory/inventoryModel.js';
import Carts from '../../models/cart/cartModel.js'; // chỉnh đường dẫn cho đúng dự án
import { generateUniqueSlug, toSlug } from '../../utils/slugify.js';
import { uploadImageToCloudinary } from '../../utils/uploadCloudinary.js';
import { normalizePricing, buildPricing, syncProductPriceRange } from '../../utils/pricing.js';
import cloudinary from '../../configs/cloudinary.js';

// status chỉ dùng để admin bật/tắt sản phẩm ở mức toàn cục.
// "Hết hàng" luôn được tính động từ Inventory (kho tổng), KHÔNG lưu cứng ở Product.
const PRODUCT_STATUS = ['draft', 'active', 'inactive'];
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Key cố định cho biến thể mặc định của sản phẩm KHÔNG có biến thể (khớp với model ProductVariants)
const DEFAULT_ATTRIBUTE_KEY = 'DEFAULT';

const MAX_SPEC_TEXT = 200; // độ dài tối đa giá trị thông số nhập tay
const MAX_SPECS = 100; // số dòng thông số tối đa trên 1 sản phẩm (mỗi giá trị đã chọn tính 1 dòng)
const MAX_ACCESSORIES = 12; // số sản phẩm đi kèm tối đa
const MAX_WARRANTY_MONTHS = 120; // số tháng bảo hành tối đa

class BadRequest extends Error { }
const bad = (msg) => {
  throw new BadRequest(msg);
};

const sendError = (res, err) => {
  // statusCode 400 được ném từ utils/pricing.js (normalizePricing)
  if (err instanceof BadRequest || err?.statusCode === 400)
    return res.status(400).json({ success: false, message: err.message });
  if (err?.code === 11000) return res.status(409).json({ success: false, message: 'SKU hoặc slug đã tồn tại' });
  return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
};

const parseBody = (req) => {
  if (typeof req.body?.data === 'string') {
    try {
      return JSON.parse(req.body.data);
    } catch {
      bad('Dữ liệu gửi lên không hợp lệ');
    }
  }
  return req.body || {};
};

const toPlain = (subdoc) => (subdoc?.toObject ? subdoc.toObject() : subdoc || null);
const normalizeSoldCount = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) bad('Số lượng đã bán phải là số nguyên không âm');
  if (n > 1_000_000_000) bad('Số lượng đã bán quá lớn');
  return n;
};

// Lấy mã video 11 ký tự từ link YouTube (watch, youtu.be, embed, shorts, live) hoặc mã dán thẳng
const extractYoutubeId = (input) => {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/);
  return m ? m[1] : null;
};

// Video sản phẩm: rỗng/null -> không có video, có link thì phải là link YouTube hợp lệ
const normalizeVideo = (v) => {
  const url = String((typeof v === 'string' ? v : v?.youtubeUrl) ?? '').trim();
  if (!url) return { youtubeUrl: '', videoId: '' };
  const videoId = extractYoutubeId(url);
  if (!videoId) bad('Link video YouTube không hợp lệ');
  return { youtubeUrl: url, videoId };
};

// Trả về {url, publicId} để lưu đúng schema và xóa chính xác khi cần rollback
const uploadImage = async (file, uploadedIds) => {
  const result = await uploadImageToCloudinary(file.buffer, 'products');
  uploadedIds.push(result.public_id);
  return { url: result.secure_url, publicId: result.public_id };
};

const destroyImages = (publicIds) =>
  Promise.allSettled(publicIds.filter(Boolean).map((id) => cloudinary.uploader.destroy(id)));

const uploadAll = async (req, variantDocs, uploadedIds) => {
  const files = req.files || [];
  const imageFiles = files.filter((f) => f.fieldname === 'images');
  const images = new Array(imageFiles.length);

  const settled = await Promise.allSettled([
    ...imageFiles.map(async (f, i) => {
      images[i] = await uploadImage(f, uploadedIds);
    }),
    ...variantDocs.map(async (v) => {
      const f = files.find((x) => x.fieldname === `variantImage_${v.index}`);
      v.newImage = f ? await uploadImage(f, uploadedIds) : null;
    }),
  ]);
  const failed = settled.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return images;
};

/**
 * Kiểm tra biến thể + resolve thuộc tính từ DB (không tin tên/giá trị từ client).
 * - Chỉ nhận Attribute loại 'variant' (spec bị chặn).
 * - attributeKey chống trùng tổ hợp thuộc tính (khớp unique index { product, attributeKey }).
 * - pricing của biến thể: TÙY CHỌN. Không nhập giá = kế thừa giá sản phẩm.
 *   Sản phẩm không có biến thể thì biến thể mặc định luôn kế thừa giá sản phẩm.
 */
const buildVariantDocs = async ({ hasVariants, attributes, variantInputs }) => {
  const attributeIds = hasVariants ? attributes.map((a) => a.attribute).filter(Boolean) : [];
  const attrDocs = attributeIds.length
    ? await mongoose.model('Attributes').find({ _id: { $in: attributeIds } }).lean()
    : [];
  const attrMap = new Map(attrDocs.map((a) => [String(a._id), a]));
  if (attrDocs.length !== new Set(attributeIds.map(String)).size) bad('Có thuộc tính không tồn tại');

  // Thuộc tính 'spec' (chỉ mô tả) không được dùng để sinh biến thể
  const wrongType = attrDocs.find((a) => a.type === 'spec');
  if (wrongType) bad(`"${wrongType.name}" là thông số mô tả, không dùng để sinh biến thể`);

  const comboKeys = new Set();
  const variantDocs = variantInputs.map((v, index) => {
    if (!v.sku?.trim()) bad('Mỗi biến thể cần có SKU');

    const attrs = (hasVariants ? v.attributes || [] : []).map((x) => {
      const attr = attrMap.get(String(x.attribute));
      if (!attr) bad(`Biến thể ${v.sku}: thuộc tính không hợp lệ`);
      const val = attr.values.find((y) => String(y._id) === String(x.value));
      if (!val) bad(`Biến thể ${v.sku}: giá trị không thuộc thuộc tính "${attr.name}"`);
      return {
        attribute: attr._id,
        attributeName: attr.name,
        valueId: val._id,
        value: val.value,
      };
    });

    const attributeKey = hasVariants
      ? attrs.map((a) => `${a.attribute}:${a.valueId}`).sort().join('|')
      : DEFAULT_ATTRIBUTE_KEY;

    if (hasVariants) {
      if (comboKeys.has(attributeKey)) bad(`Biến thể ${v.sku} bị trùng tổ hợp thuộc tính`);
      comboKeys.add(attributeKey);
    }

    return {
      index,
      _id: v._id, // có -> biến thể đã tồn tại (khi sửa)
      imageUrl: v.imageUrl, // '' = xóa ảnh, undefined/URL = giữ nguyên (khi sửa)
      sku: v.sku.trim(),
      barcode: v.barcode || '',
      weight: Number(v.weight) > 0 ? Number(v.weight) : 0,
      isActive: v.active !== false,
      isDefault: !hasVariants,
      attributeKey,
      attributes: attrs,
      pricing: hasVariants ? normalizePricing(v.pricing, `Biến thể ${v.sku.trim()}`) : undefined,
    };
  });

  return { attributeIds, variantDocs };
};

// Chuẩn hóa 1 dòng thông số từ client. Hỗ trợ cả dạng cũ { valueId }.
const normalizeSpecInput = (s) => {
  const ids = Array.isArray(s?.valueIds) ? s.valueIds : s?.valueId ? [s.valueId] : [];
  return {
    attribute: s?.attribute,
    valueIds: [...new Set(ids.filter(Boolean).map(String))],
    value: String(s?.value ?? '').trim(),
  };
};

/**
 * Kiểm tra + resolve THÔNG SỐ (thuộc tính không sinh biến thể) từ DB. Không tin tên/giá trị từ client.
 *
 * raw: [{ attribute, valueIds: [...] }] -> attribute inputType 'select' (chọn NHIỀU giá trị)
 *      [{ attribute, value }]           -> attribute inputType 'text'
 *      (vẫn nhận dạng cũ { attribute, valueId })
 *
 * Kết quả là mảng PHẲNG: mỗi giá trị đã chọn là một dòng (cùng attribute, khác valueId).
 * Nhờ vậy model, index, bộ lọc ($elemMatch) và đồng bộ đổi tên ở attributeController không cần đổi.
 *
 * - Bỏ qua dòng trống (không có giá trị nào).
 * - Mỗi attribute chỉ xuất hiện 1 lần trong request.
 * - Chỉ nhận Attribute loại 'spec'.
 * - Attribute đã ngưng hoạt động chỉ được giữ nếu sản phẩm đã gán từ trước (allowedInactiveIds).
 */
const buildSpecs = async (raw, { allowedInactiveIds = new Set() } = {}) => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) bad('specs phải là một mảng');

  const items = raw.map(normalizeSpecInput).filter((s) => s.valueIds.length || s.value);
  if (items.length === 0) return [];

  const seen = new Set();
  for (const s of items) {
    if (!isValidId(s.attribute)) bad('Thông số có thuộc tính không hợp lệ');
    const key = String(s.attribute);
    if (seen.has(key)) bad('Mỗi thuộc tính thông số chỉ được gửi một lần');
    seen.add(key);
  }

  const docs = await mongoose
    .model('Attributes')
    .find({ _id: { $in: [...seen] } })
    .lean();
  const docMap = new Map(docs.map((d) => [String(d._id), d]));

  const result = items.flatMap((s) => {
    const attr = docMap.get(String(s.attribute));
    if (!attr) bad('Có thuộc tính thông số không tồn tại');
    if (attr.type !== 'spec') bad(`"${attr.name}" là thuộc tính biến thể, không dùng làm thông số`);
    if (!attr.isActive && !allowedInactiveIds.has(String(attr._id))) {
      bad(`Thuộc tính "${attr.name}" đang ngưng hoạt động`);
    }

    // Nhập tay: 1 dòng
    if (attr.inputType === 'text') {
      if (!s.value) bad(`Thông số "${attr.name}" chưa có giá trị`);
      if (s.value.length > MAX_SPEC_TEXT) bad(`Thông số "${attr.name}" tối đa ${MAX_SPEC_TEXT} ký tự`);
      return [
        {
          attribute: attr._id,
          attributeName: attr.name,
          valueId: null,
          value: s.value,
          valueSlug: toSlug(s.value),
        },
      ];
    }

    // Chọn từ danh sách: mỗi giá trị 1 dòng
    if (s.valueIds.length === 0) bad(`Thông số "${attr.name}": hãy chọn ít nhất một giá trị`);
    return s.valueIds.map((vid) => {
      if (!isValidId(vid)) bad(`Thông số "${attr.name}": giá trị không hợp lệ`);
      const val = (attr.values || []).find((v) => String(v._id) === vid);
      if (!val) bad(`Thông số "${attr.name}": giá trị không thuộc thuộc tính này`);
      return {
        attribute: attr._id,
        attributeName: attr.name,
        valueId: val._id,
        value: val.value,
        valueSlug: val.slug,
      };
    });
  });

  if (result.length > MAX_SPECS) bad(`Tối đa ${MAX_SPECS} thông số cho mỗi sản phẩm`);
  return result;
};

/**
 * Kiểm tra SẢN PHẨM ĐI KÈM. Chỉ nhận mảng ID (hoặc object có _id), không tin dữ liệu khác từ client.
 * - undefined/null -> [].
 * - Khử trùng, GIỮ NGUYÊN thứ tự (thứ tự = thứ tự hiển thị).
 * - Tối đa MAX_ACCESSORIES; không được tự chọn chính nó (selfId, khi sửa).
 * - Sản phẩm phải tồn tại và chưa bị xoá mềm. KHÔNG ràng buộc status: admin được chọn cả draft/inactive.
 */
const buildAccessories = async (raw, selfId = null) => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) bad('accessories phải là một mảng');

  const ids = [...new Set(raw.map((x) => String(x?._id ?? x)).filter(Boolean))];
  if (ids.length > MAX_ACCESSORIES) bad(`Tối đa ${MAX_ACCESSORIES} sản phẩm đi kèm`);

  for (const id of ids) {
    if (!isValidId(id)) bad('Sản phẩm đi kèm có ID không hợp lệ');
    if (selfId && id === String(selfId)) bad('Không thể chọn chính sản phẩm này làm sản phẩm đi kèm');
  }

  if (ids.length) {
    const found = await Product.countDocuments({ _id: { $in: ids }, deletedAt: null });
    if (found !== ids.length) bad('Có sản phẩm đi kèm không tồn tại hoặc đã bị xoá');
  }
  return ids;
};

/**
 * Số tháng bảo hành. Rỗng/null/undefined -> 0 (không bảo hành). Phải là số nguyên 0..MAX_WARRANTY_MONTHS.
 */
const normalizeWarrantyMonths = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) bad('Số tháng bảo hành phải là số nguyên không âm');
  if (n > MAX_WARRANTY_MONTHS) bad(`Số tháng bảo hành tối đa ${MAX_WARRANTY_MONTHS}`);
  return n;
};

/**
 * MỚI: Sản phẩm "Có biến thể" bắt buộc phải sinh ít nhất 1 biến thể và chọn ít nhất 1 thuộc tính,
 * áp dụng cho MỌI trạng thái (kể cả lưu nháp).
 */
const assertVariantsProvided = ({ hasVariants, attributes, variants }) => {
  if (!hasVariants) return;
  const attrCount = Array.isArray(attributes) ? attributes.filter((a) => a?.attribute).length : 0;
  if (attrCount === 0) bad('Sản phẩm có biến thể cần chọn ít nhất một thuộc tính');
  if (!Array.isArray(variants) || variants.length === 0)
    bad('Sản phẩm có biến thể cần ít nhất một biến thể. Hãy chọn thuộc tính và sinh biến thể');
};

// Resolve accessories cho form admin (chip), giữ đúng thứ tự đã lưu
const resolveAccessoriesForAdmin = async (ids = []) => {
  if (!ids.length) return [];
  const docs = await Product.find({ _id: { $in: ids } })
    .select('name slug images priceMin priceMax status deletedAt')
    .lean();
  const map = new Map(docs.map((p) => [String(p._id), p]));
  return ids
    .map((id) => map.get(String(id)))
    .filter(Boolean) // sản phẩm bị xoá cứng -> bỏ
    .map((p) => ({
      _id: p._id,
      name: p.name,
      slug: p.slug,
      image: p.images?.[0]?.url || '',
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      status: p.status,
      deleted: !!p.deletedAt,
    }));
};

// SKU không được trùng trong request, cũng không được trùng biến thể khác trong DB
const assertSkuFree = async (variantDocs) => {
  const skus = variantDocs.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) bad('SKU bị trùng trong danh sách biến thể');

  const owner = new Map(variantDocs.filter((v) => v._id).map((v) => [String(v._id), v.sku]));
  const found = await ProductVariant.find({ sku: { $in: skus } }).select('sku').lean();
  const taken = found.filter((f) => owner.get(String(f._id)) !== f.sku);
  if (taken.length) bad(`SKU đã tồn tại: ${taken.map((x) => x.sku).join(', ')}`);
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
};

const variantToDoc = (productId, v) => ({
  product: productId,
  sku: v.sku,
  barcode: v.barcode,
  weight: v.weight,
  isActive: v.isActive,
  isDefault: v.isDefault,
  attributes: v.attributes,
  attributeKey: v.attributeKey,
  image: v.newImage || { url: '', publicId: '' },
  pricing: v.pricing ? buildPricing(v.pricing, null, 'Khởi tạo giá') : undefined,
});

// Mỗi biến thể có đúng 1 bản ghi tồn kho trong kho tổng (quantity = 0 lúc mới tạo)
const createInventoryFor = (productId, variantList) =>
  Inventory.insertMany(
    variantList.map((v) => ({ variant: v._id, product: productId, quantity: 0, reservedQuantity: 0 }))
  );

/* ------------------------------------------------------------------ */
/* Điều kiện đăng bán                                                  */
/* ------------------------------------------------------------------ */
const checkPublishReadiness = async (productId) => {
  const reasons = [];

  const product = await Product.findById(productId).select('pricing').lean();
  if (!product?.pricing?.price || product.pricing.price <= 0) {
    reasons.push('Sản phẩm chưa có giá bán');
  }

  const variants = await ProductVariant.find({ product: productId, isActive: true })
    .select('_id sku pricing')
    .lean();

  if (variants.length === 0) {
    reasons.push('Sản phẩm chưa có biến thể nào đang hoạt động');
  }

  // Biến thể có khai báo giá riêng thì giá đó phải > 0 (không khai báo = kế thừa, hợp lệ)
  const invalidPriceVariants = variants.filter((v) => v.pricing && v.pricing.price != null && v.pricing.price <= 0);
  if (invalidPriceVariants.length > 0) {
    reasons.push(`${invalidPriceVariants.length} biến thể có giá riêng không hợp lệ`);
  }

  // Phải có ít nhất 1 biến thể đang hoạt động còn tồn kho khả dụng (quantity - reservedQuantity > 0)
  let inStockVariantCount = 0;
  if (variants.length > 0) {
    const invDocs = await Inventory.find({
      variant: { $in: variants.map((v) => v._id) },
      isActive: true,
    })
      .select('variant quantity reservedQuantity')
      .lean();
    inStockVariantCount = invDocs.filter((i) => i.quantity - i.reservedQuantity > 0).length;

    if (inStockVariantCount === 0) {
      reasons.push('Cần ít nhất 1 biến thể còn tồn kho để đăng bán');
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    variantCount: variants.length,
    inStockVariantCount,
    invalidPriceVariants: invalidPriceVariants.map((v) => ({ variantId: v._id, sku: v.sku })),
  };
};

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */
const productController = {
  createProduct: async (req, res) => {
    const uploadedIds = [];
    let product = null;

    try {
      const body = parseBody(req);
      const {
        name,
        description = '',
        shortDescription = '',
        category,
        brand = null,
        hasVariants = false,
        attributes = [], // thuộc tính SINH biến thể: [{ attribute }]
        variants = [], // [{ sku, barcode, weight, active, attributes: [{attribute, value}], pricing? }]
        tags = [],
        status = 'draft',
      } = body;

      if (!name?.trim()) bad('Nhập tên sản phẩm');
      if (!category) bad('Chọn danh mục');
      if (!PRODUCT_STATUS.includes(status)) bad('Trạng thái không hợp lệ');
      // Sản phẩm mới tạo luôn có tồn kho = 0 nên chưa thể đăng bán ngay
      if (status === 'active') bad('Sản phẩm mới chưa có tồn kho. Hãy lưu nháp, nhập kho rồi đăng bán');

      // Có biến thể thì bắt buộc phải sinh biến thể, kể cả khi lưu nháp
      assertVariantsProvided({ hasVariants, attributes, variants });

      // Giá sản phẩm: BẮT BUỘC
      const productPricing = normalizePricing(body.pricing, 'Giá sản phẩm', { required: true });

      // Video sản phẩm (tuỳ chọn, tối đa 1): kiểm tra TRƯỚC khi upload ảnh
      const video = normalizeVideo(body.video);

      // Thông số kỹ thuật (thuộc tính KHÔNG sinh biến thể): kiểm tra TRƯỚC khi upload ảnh
      const specs = await buildSpecs(body.specs);

      // Sản phẩm đi kèm (tuỳ chọn): kiểm tra TRƯỚC khi upload ảnh
      const accessories = await buildAccessories(body.accessories);

      // Số tháng bảo hành (tuỳ chọn): kiểm tra TRƯỚC khi upload ảnh
      const warrantyMonths = normalizeWarrantyMonths(body.warrantyMonths);

      // Không có biến thể -> chỉ giữ 1 SKU mặc định (không có thuộc tính)
      const variantInputs = hasVariants ? variants : variants.slice(0, 1);
      if (!hasVariants && variantInputs.length === 0) bad('Thiếu SKU mặc định');

      const { attributeIds, variantDocs } = await buildVariantDocs({ hasVariants, attributes, variantInputs });
      await assertSkuFree(variantDocs);

      // Chỉ upload ảnh SAU KHI đã validate xong toàn bộ dữ liệu
      const images = await uploadAll(req, variantDocs, uploadedIds);

      const slug = await generateUniqueSlug(name, Product);
      product = await Product.create({
        name: name.trim(),
        slug,
        description,
        shortDescription,
        category,
        brand: brand || null,
        images,
        video,
        hasVariants,
        variantAttributes: attributeIds,
        specs,
        accessories,
        warrantyMonths,
        pricing: buildPricing(productPricing, null, 'Khởi tạo giá'),
        priceMin: productPricing.price,
        priceMax: productPricing.price,
        tags,
        soldCount: normalizeSoldCount(body.soldCount),
        status,
      });

      const variantList = await ProductVariant.insertMany(variantDocs.map((v) => variantToDoc(product._id, v)));
      await createInventoryFor(product._id, variantList);
      await syncProductPriceRange(product._id);

      const data = await Product.findById(product._id).lean();
      return res.status(201).json({ success: true, data: { ...data, variants: variantList } });
    } catch (err) {
      // Lỗi sau khi upload -> xóa ảnh vừa đẩy lên + dọn dữ liệu DB tạo dở
      try {
        await destroyImages(uploadedIds);
        if (product) {
          await Inventory.deleteMany({ product: product._id });
          await ProductVariant.deleteMany({ product: product._id });
          await Product.deleteOne({ _id: product._id });
        }
      } catch (cleanupErr) {
        console.error('Rollback createProduct thất bại:', cleanupErr);
      }
      return sendError(res, err);
    }
  },

  updateProduct: async (req, res) => {
    const uploadedIds = []; // ảnh MỚI vừa upload
    const removedPublicIds = []; // ảnh CŨ sẽ bị thay/gỡ (chỉ xóa khi DB đã lưu thành công)

    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) bad('ID sản phẩm không hợp lệ');

      const product = await Product.findById(id);
      if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
      // Sản phẩm trong thùng rác không được sửa (tránh vô tình đặt lại 'active' khi còn deletedAt)
      if (product.deletedAt) bad('Sản phẩm đã bị xoá, hãy khôi phục trước khi chỉnh sửa');

      const body = parseBody(req);
      const {
        name,
        description = '',
        shortDescription = '',
        category,
        brand = null,
        attributes = [],
        variants = [],
        tags = [],
        status = 'draft',
        keepImages = [],
        priceNote = '', // ghi chú lưu vào lịch sử giá khi có thay đổi
      } = body;

      if (!name?.trim()) bad('Nhập tên sản phẩm');
      if (!category) bad('Chọn danh mục');
      if (!PRODUCT_STATUS.includes(status)) bad('Trạng thái không hợp lệ');

      // Cho phép nâng cấp "không biến thể" -> "có biến thể". Chiều ngược lại bị chặn.
      const requestedHasVariants = body.hasVariants === undefined ? product.hasVariants : !!body.hasVariants;
      if (product.hasVariants && !requestedHasVariants)
        bad('Sản phẩm đã có biến thể, không thể chuyển về không có biến thể');

      const hasVariants = requestedHasVariants;
      const isUpgrade = !product.hasVariants && hasVariants;

      // Có biến thể thì bắt buộc phải sinh biến thể, kể cả khi lưu nháp
      assertVariantsProvided({ hasVariants, attributes, variants });

      // Chuyển sang 'active' (đăng bán) qua form sửa cũng phải đủ điều kiện như API publish
      // (khi nâng cấp biến thể thì điều kiện đăng bán sẽ do API publish kiểm tra sau, nên chặn ở đây)
      if (status === 'active' && product.status !== 'active') {
        if (isUpgrade) bad('Hãy lưu thay đổi biến thể trước, sau đó bấm "Đăng bán"');
        const readiness = await checkPublishReadiness(product._id);
        if (!readiness.ready) bad(`Chưa thể đăng bán: ${readiness.reasons.join('; ')}`);
      }

      const productPricing = normalizePricing(body.pricing, 'Giá sản phẩm', { required: true });

      // Video: không gửi (undefined) = giữ nguyên; gửi null / rỗng = xoá video
      const video = body.video !== undefined ? normalizeVideo(body.video) : undefined;

      // Thông số: không gửi (undefined) = giữ nguyên; gửi mảng (kể cả rỗng) = thay toàn bộ.
      // Thuộc tính spec đã ngưng hoạt động vẫn được giữ nếu sản phẩm đã gán từ trước.
      const specs =
        body.specs !== undefined
          ? await buildSpecs(body.specs, {
            allowedInactiveIds: new Set((product.specs || []).map((s) => String(s.attribute))),
          })
          : undefined;

      // Sản phẩm đi kèm: không gửi = giữ nguyên; gửi mảng (kể cả rỗng) = thay toàn bộ.
      const accessories =
        body.accessories !== undefined ? await buildAccessories(body.accessories, product._id) : undefined;

      // Số tháng bảo hành: không gửi = giữ nguyên; gửi rỗng/null = 0 (không bảo hành)
      const warrantyMonths =
        body.warrantyMonths !== undefined ? normalizeWarrantyMonths(body.warrantyMonths) : undefined;

      const existing = await ProductVariant.find({ product: product._id });
      const existingMap = new Map(existing.map((v) => [String(v._id), v]));

      const variantInputs = hasVariants ? variants : variants.slice(0, 1);
      if (!hasVariants && variantInputs.length === 0) bad('Thiếu SKU mặc định');

      if (isUpgrade) {
        if (!attributes.length || variantInputs.length === 0)
          bad('Hãy chọn thuộc tính và sinh ít nhất một biến thể');

        // Biến thể mặc định cũ được kế thừa bởi biến thể đầu tiên (giữ tồn kho, giỏ hàng, đơn hàng)
        const oldDefault = existing.find((v) => v.isDefault);
        if (oldDefault && !variantInputs.some((v) => String(v._id) === String(oldDefault._id))) {
          variantInputs[0]._id = oldDefault._id;
        }
      }

      for (const v of variantInputs) {
        if (v._id && !existingMap.has(String(v._id))) bad('Có biến thể không thuộc sản phẩm này');
      }

      const { attributeIds, variantDocs } = await buildVariantDocs({ hasVariants, attributes, variantInputs });
      await assertSkuFree(variantDocs);

      /* ----- Upload ảnh mới (sau khi đã validate xong) ----- */
      const newImages = await uploadAll(req, variantDocs, uploadedIds);

      /* ----- Biến thể (xử lý TRƯỚC khi lưu product để lỗi biến thể không làm đổi hasVariants) ----- */
      const seen = new Set();
      const toCreate = [];

      for (const v of variantDocs) {
        if (!v._id) {
          toCreate.push(v);
          continue;
        }
        const doc = existingMap.get(String(v._id));
        seen.add(String(v._id));

        let image = doc.image || { url: '', publicId: '' };
        if (v.newImage) {
          if (doc.image?.publicId) removedPublicIds.push(doc.image.publicId);
          image = v.newImage;
        } else if (v.imageUrl === '') {
          if (doc.image?.publicId) removedPublicIds.push(doc.image.publicId);
          image = { url: '', publicId: '' };
        }

        doc.set({
          sku: v.sku,
          barcode: v.barcode,
          weight: v.weight,
          isActive: v.isActive,
          isDefault: v.isDefault, // false khi nâng cấp lên "có biến thể"
          attributes: v.attributes,
          attributeKey: v.attributeKey, // 'DEFAULT' -> khoá tổ hợp thuộc tính thật
          image,
          // Có giá riêng -> cập nhật (kèm lịch sử). Không có -> bỏ override, kế thừa giá sản phẩm.
          pricing: v.pricing ? buildPricing(v.pricing, toPlain(doc.pricing), priceNote) : undefined,
        });
        await doc.save();
      }

      // biến thể cũ không còn trong danh sách -> inactive
      for (const doc of existing) {
        if (!seen.has(String(doc._id)) && doc.isActive) {
          doc.isActive = false;
          doc.isDefault = false;
          await doc.save();
        }
      }

      // biến thể mới -> tạo luôn bản ghi tồn kho (quantity = 0) trong kho tổng
      if (toCreate.length) {
        const created = await ProductVariant.insertMany(toCreate.map((v) => variantToDoc(product._id, v)));
        await createInventoryFor(product._id, created);
      }

      /* ----- Ảnh sản phẩm + lưu product ----- */
      const keep = product.images.filter((img) => keepImages.includes(img.url));
      const removed = product.images.filter((img) => !keep.includes(img));
      removedPublicIds.push(...removed.map((img) => img.publicId));

      product.set({
        name: name.trim(),
        description,
        shortDescription,
        category,
        brand: brand || null,
        images: [...keep, ...newImages],
        pricing: buildPricing(productPricing, toPlain(product.pricing), priceNote),
        tags,
        status,
        hasVariants,
        ...(video !== undefined && { video }),
        ...(specs !== undefined && { specs }),
        ...(accessories !== undefined && { accessories }),
        ...(warrantyMonths !== undefined && { warrantyMonths }),
        ...(body.soldCount !== undefined && { soldCount: normalizeSoldCount(body.soldCount) }),
      });
      if (hasVariants) product.variantAttributes = attributeIds;
      await product.save();

      await syncProductPriceRange(product._id);

      // Mọi thao tác DB đã thành công -> giờ mới dọn ảnh cũ không còn dùng
      await destroyImages(removedPublicIds);

      const data = await Product.findById(product._id).lean();
      data.variants = await ProductVariant.find({ product: product._id }).sort({ createdAt: 1 }).lean();
      return res.json({ success: true, data });
    } catch (err) {
      await destroyImages(uploadedIds).catch((e) => console.error('Rollback ảnh updateProduct thất bại:', e));
      return sendError(res, err);
    }
  },

  /**
   * GET /admin/products
   * Mặc định ẩn sản phẩm đã xoá mềm. ?deleted=true chỉ trả sản phẩm trong thùng rác.
   * ?excludeId=<id> loại trừ 1 sản phẩm (ô chọn sản phẩm đi kèm không hiện chính nó).
   * Mỗi dòng trả thêm `warrantyMonths` (0 = không bảo hành).
   */
  getProducts: async (req, res) => {
    try {
      const page = toInt(req.query.page, 1, 1, 1e6);
      const limit = toInt(req.query.limit, 10, 1, 100);
      const search = (req.query.search || '').trim();
      const { category, brand, status } = req.query;
      const sort = SORTS[req.query.sort] || SORTS.newest;

      /* ----- Bộ lọc ----- */
      const filter = {};

      // { deletedAt: null } khớp cả sản phẩm cũ chưa có field này
      filter.deletedAt = req.query.deleted === 'true' ? { $ne: null } : null;

      if (category && category !== 'all') {
        if (!mongoose.isValidObjectId(category)) bad('Danh mục không hợp lệ');
        filter.category = category;
      }
      if (brand && brand !== 'all') {
        if (!mongoose.isValidObjectId(brand)) bad('Thương hiệu không hợp lệ');
        filter.brand = brand;
      }
      if (status && status !== 'all') {
        if (!PRODUCT_STATUS.includes(status)) bad('Trạng thái không hợp lệ');
        filter.status = status;
      }
      if (req.query.excludeId && isValidId(req.query.excludeId)) {
        filter._id = { $ne: req.query.excludeId };
      }
      if (search) {
        // Tách từ khóa thành từng từ (tối đa 10 từ để tránh truy vấn quá nặng)
        const terms = search.split(/\s+/).filter(Boolean).slice(0, 10);

        // Mỗi từ phải khớp ở name, slug hoặc tags (AND giữa các từ, OR giữa các trường)
        const termConds = terms.map((t) => {
          const re = new RegExp(escapeRegex(t), 'i');
          return { $or: [{ name: re }, { slug: re }, { tags: re }] };
        });

        // SKU vẫn tìm theo nguyên cụm vì SKU không chứa dấu cách
        const skuRe = new RegExp(escapeRegex(search), 'i');
        const idsBySku = await ProductVariant.find({ sku: skuRe }).distinct('product');

        filter.$or = [{ $and: termConds }, { _id: { $in: idsBySku } }];
        if (/^[a-f\d]{24}$/i.test(search)) filter.$or.push({ _id: search });
      }

      /* ----- Truy vấn trang hiện tại + tổng + thống kê ----- */
      const [products, total, statusCounts, deletedCount] = await Promise.all([
        Product.find(filter)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .select(
            'name slug images category brand status tags hasVariants priceMin priceMax warrantyMonths createdAt deletedAt'
          )
          .populate('category', 'name')
          .populate('brand', 'name')
          .lean(),
        Product.countDocuments(filter),
        // thống kê chỉ tính sản phẩm chưa xoá
        Product.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Product.countDocuments({ deletedAt: { $ne: null } }),
      ]);

      /* ----- Gộp số biến thể + tồn kho (kho tổng) cho các sản phẩm trong trang ----- */
      const ids = products.map((p) => p._id);
      const [variantAgg, stockAgg] = ids.length
        ? await Promise.all([
          ProductVariant.aggregate([
            { $match: { product: { $in: ids }, isActive: true } },
            { $group: { _id: '$product', count: { $sum: 1 } } },
          ]),
          Inventory.aggregate([
            { $match: { product: { $in: ids } } },
            { $group: { _id: '$product', quantity: { $sum: '$quantity' }, reserved: { $sum: '$reservedQuantity' } } },
          ]),
        ])
        : [[], []];

      const toMap = (arr) => new Map(arr.map((x) => [String(x._id), x]));
      const variantMap = toMap(variantAgg);
      const stockMap = toMap(stockAgg);

      const data = products.map((p) => {
        const key = String(p._id);
        const stock = stockMap.get(key);
        const { images = [], priceMin, priceMax, ...rest } = p;
        return {
          ...rest,
          image: images[0]?.url || '',
          variantCount: variantMap.get(key)?.count || 0,
          minPrice: priceMin ?? 0,
          maxPrice: priceMax ?? 0,
          stock: stock?.quantity ?? 0, // tồn vật lý trong kho tổng
          availableStock: (stock?.quantity ?? 0) - (stock?.reserved ?? 0), // có thể bán
        };
      });

      const counts = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
      const stats = {
        total: statusCounts.reduce((sum, s) => sum + s.count, 0),
        active: counts.active || 0,
        inactive: counts.inactive || 0,
        draft: counts.draft || 0,
        deleted: deletedCount, // số sản phẩm trong thùng rác
      };

      return res.json({
        success: true,
        data,
        pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
        stats,
      });
    } catch (err) {
      return sendError(res, err);
    }
  },

  // Trả cả `specs` (mảng phẳng, mỗi giá trị đã chọn là 1 dòng) để form sửa gộp lại theo thuộc tính
  // Trả thêm `accessories` đã resolve (giữ thứ tự) để form hiển thị chip
  // `warrantyMonths` nằm sẵn trong product (sản phẩm cũ chưa có field -> trả 0)
  getProductDetail: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) bad('ID sản phẩm không hợp lệ');

      const product = await Product.findById(id).lean();
      if (!product) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });

      const [variants, invDocs, accessories] = await Promise.all([
        ProductVariant.find({ product: id }).sort({ createdAt: 1 }).lean(),
        Inventory.find({ product: id }).select('variant quantity reservedQuantity reorderLevel').lean(),
        resolveAccessoriesForAdmin(product.accessories || []),
      ]);

      const invMap = new Map(invDocs.map((i) => [String(i.variant), i]));
      const data = variants.map((v) => {
        const inv = invMap.get(String(v._id));
        const quantity = inv?.quantity ?? 0;
        const reservedQuantity = inv?.reservedQuantity ?? 0;
        return {
          ...v,
          inventory: {
            quantity,
            reservedQuantity,
            availableQuantity: Math.max(0, quantity - reservedQuantity),
            reorderLevel: inv?.reorderLevel ?? 0,
          },
        };
      });

      return res.json({
        success: true,
        data: {
          ...product,
          specs: product.specs || [],
          accessories,
          warrantyMonths: product.warrantyMonths ?? 0,
          variants: data,
        },
      });
    } catch (err) {
      return sendError(res, err);
    }
  },

  /** POST /admin/products/:productId/publish */
  publishProduct: async (req, res) => {
    try {
      const { productId } = req.params;
      if (!isValidId(productId)) {
        return res.status(400).json({ success: false, message: 'productId không hợp lệ' });
      }

      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
      }
      if (product.deletedAt) {
        return res
          .status(409)
          .json({ success: false, message: 'Sản phẩm đã bị xoá, hãy khôi phục trước khi đăng bán' });
      }
      if (product.status === 'active') {
        return res.status(200).json({ success: true, message: 'Sản phẩm đã được đăng bán', data: product });
      }

      const readiness = await checkPublishReadiness(productId);
      if (!readiness.ready) {
        return res.status(422).json({
          success: false,
          message: 'Sản phẩm chưa đủ điều kiện đăng bán',
          data: readiness,
        });
      }

      product.status = 'active';
      await product.save();

      return res.status(200).json({
        success: true,
        message: 'Đăng bán sản phẩm thành công',
        data: { product },
      });
    } catch (error) {
      console.error('publishProduct:', error);
      return res.status(500).json({ success: false, message: 'Lỗi đăng bán sản phẩm', error: error.message });
    }
  },

  /**
   * DELETE /admin/products/:id  (xoá mềm -> chuyển vào thùng rác)
   *
   * - Đặt deletedAt, status = 'inactive' => mọi trang phía khách tự ẩn sản phẩm.
   * - KHÔNG đụng tới biến thể và tồn kho: đơn đang xử lý vẫn huỷ / hoàn tất bình thường.
   * - Gỡ các dòng của sản phẩm khỏi giỏ hàng của mọi khách.
   * - Atomic: bấm 2 lần chỉ xoá 1 lần (điều kiện deletedAt: null).
   * - Sản phẩm đi kèm không cần dọn: phía khách lọc lúc đọc (active + chưa xoá).
   */
  deleteProduct: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) bad('ID sản phẩm không hợp lệ');

      const product = await Product.findOneAndUpdate(
        { _id: id, deletedAt: null },
        { $set: { status: 'inactive', deletedAt: new Date(), deletedBy: req.user?.id ?? null } },
        { new: true }
      )
        .select('_id name status deletedAt')
        .lean();

      if (!product) {
        const exists = await Product.exists({ _id: id });
        if (!exists) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
        return res.status(409).json({ success: false, message: 'Sản phẩm đã được xoá trước đó' });
      }

      // Dọn giỏ hàng: lỗi ở bước này không làm hỏng việc xoá (giỏ vẫn hiện "ngừng bán" và bị chặn thanh toán)
      let removedFromCarts = 0;
      try {
        const variantIds = await ProductVariant.find({ product: id }).distinct('_id');
        const result = await Carts.updateMany(
          { 'items.variant': { $in: variantIds } },
          { $pull: { items: { variant: { $in: variantIds } } } }
        );
        removedFromCarts = result.modifiedCount;
      } catch (cartErr) {
        console.error('deleteProduct: dọn giỏ hàng thất bại:', cartErr);
      }

      return res.json({
        success: true,
        message: 'Đã chuyển sản phẩm vào thùng rác',
        data: { ...product, removedFromCarts },
      });
    } catch (err) {
      return sendError(res, err);
    }
  },

  /**
   * POST /admin/products/:id/restore  (khôi phục từ thùng rác)
   * Sản phẩm quay về trạng thái 'draft' (không tự đăng bán lại): admin kiểm tra rồi bấm đăng bán,
   * khi đó vẫn phải qua điều kiện đăng bán (giá, biến thể, tồn kho).
   * Các dòng đã bị gỡ khỏi giỏ hàng không được khôi phục.
   */
  restoreProduct: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) bad('ID sản phẩm không hợp lệ');

      const product = await Product.findOneAndUpdate(
        { _id: id, deletedAt: { $ne: null } },
        { $set: { status: 'draft', deletedAt: null, deletedBy: null } },
        { new: true }
      )
        .select('_id name status deletedAt')
        .lean();

      if (!product) {
        const exists = await Product.exists({ _id: id });
        if (!exists) return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
        return res.status(409).json({ success: false, message: 'Sản phẩm này không nằm trong thùng rác' });
      }

      return res.json({
        success: true,
        message: 'Đã khôi phục sản phẩm (trạng thái nháp). Hãy kiểm tra rồi đăng bán lại',
        data: product,
      });
    } catch (err) {
      return sendError(res, err);
    }
  },
};

export default productController;