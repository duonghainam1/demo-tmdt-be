import Products from '../../models/products/productModel.js';
import ProductVariants from '../../models/products/productVariantModel.js';
import Inventory from '../../models/inventory/inventoryModel.js';
import Brands from '../../models/products/brandModel.js';
import Attributes from '../../models/products/attributeModel.js';
import Categorys from '../../models/categories/categoryModel.js';
import { buildPriceInfo, buildVariantPriceInfo, hasValidPricing } from '../../utils/pricing.js';
import { normalize, escapeRegex } from '../../utils/text.js';
import { getFlashPricingMap } from '../../services/flashSales/flashSaleService.js';

const parseRange = (str) => {
  if (!str) return null;
  const [minRaw, maxRaw] = String(str).split('-');
  const min = Number(String(minRaw).replace(/[^\d]/g, '')) || 0;
  const max = maxRaw ? Number(String(maxRaw).replace(/[^\d]/g, '')) || Infinity : Infinity;
  return { min, max };
};

const groupBy = (arr, keyFn) => {
  const map = new Map();
  arr.forEach((item) => {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return map;
};

const buildEntries = (variants, product, invMap, now) =>
  variants.map((variant) => {
    const inv = invMap.get(variant._id.toString());
    const available = inv ? Math.max(0, inv.quantity - inv.reservedQuantity) : 0;
    return { variant, info: buildVariantPriceInfo(variant, product, now), available };
  });

const buildCard = (product, pool, brand, available) => {
  const cheapest = pool.reduce((m, e) => (e.info.effectivePrice < m.info.effectivePrice ? e : m), pool[0]);
  const prices = pool.map((e) => e.info.effectivePrice);

  const attributeMap = new Map();
  pool.forEach(({ variant }) => {
    (variant.attributes || []).forEach((a) => {
      if (!attributeMap.has(a.attributeName)) attributeMap.set(a.attributeName, new Set());
      attributeMap.get(a.attributeName).add(a.value);
    });
  });

  return {
    _id: product._id,
    name: product.name,
    slug: product.slug,
    image: product.images?.[0]?.url || cheapest.variant.image?.url || '',
    brand,
    attributes: [...attributeMap.entries()].map(([name, values]) => ({ name, values: [...values] })),
    price: { min: Math.min(...prices), max: Math.max(...prices) },
    originalPrice: cheapest.info.originalPrice,
    isSale: cheapest.info.isSale,
    discountPercent: cheapest.info.discountPercent,
    ratingAverage: product.ratingAverage,
    ratingCount: product.ratingCount,
    soldCount: product.soldCount,
    createdAt: product.createdAt,
    variantCount: pool.length,
    available,
  };
};

const loadInventoryMap = async (variantIds) => {
  const docs = await Inventory.find({ variant: { $in: variantIds }, isActive: true })
    .select('variant quantity reservedQuantity')
    .lean();
  return new Map(docs.map((i) => [i.variant.toString(), i]));
};

/**
 * Lọc theo query:
 *  - ?brands=a,b  ?tags=x,y  ?search=...
 *  - ?<slug thuộc tính biến thể>=<slug giá trị,...>  -> lọc trên BIẾN THỂ
 *  - ?<slug thông số>=<slug giá trị,...>              -> lọc trên SẢN PHẨM (specs)
 *  Nhiều giá trị của cùng một thuộc tính = OR; nhiều thuộc tính khác nhau = AND.
 *
 *  Thông số chọn nhiều giá trị được lưu thành nhiều dòng cùng `attribute` trong product.specs,
 *  nên $elemMatch + $in vẫn khớp khi sản phẩm có BẤT KỲ giá trị nào trong số đang lọc.
 */
const resolveFilteredData = async (req) => {
  const { category } = req.params;
  const { brands, search, tags, ...rest } = req.query;
  const { page, limit, sort, price, storeId, ...attrParams } = rest;

  const categoryDoc = await Categorys.findOne({ slug: category, isActive: true }).lean();
  if (!categoryDoc) return { categoryDoc: null };

  const childCategories = await Categorys.find({ parent: categoryDoc._id }).select('_id').lean();
  const categoryIds = [categoryDoc._id, ...childCategories.map((c) => c._id)];

  const productMatch = {
    category: { $in: categoryIds },
    status: 'active',
    deletedAt: null,
    'pricing.price': { $type: 'number' },
  };
  if (search) productMatch.$text = { $search: search };

  // ?tags=gaming,mini
  if (tags) {
    const tagList = String(tags)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tagList.length) {
      productMatch.tags = { $in: tagList }; // chọn nhiều tag = OR
      // muốn AND (phải có đủ mọi tag) thì dùng: productMatch.tags = { $all: tagList };
    }
  }

  if (brands) {
    const brandSlugs = String(brands).split(',').filter(Boolean);
    const brandDocs = await Brands.find({ slug: { $in: brandSlugs } }).select('_id').lean();
    productMatch.brand = { $in: brandDocs.map((b) => b._id) };
  }

  // ----- Lọc theo THÔNG SỐ (spec): lọc thẳng trên sản phẩm -----
  const attrKeys = Object.keys(attrParams);
  if (attrKeys.length) {
    const specDocs = await Attributes.find({
      slug: { $in: attrKeys },
      type: 'spec',
      isActive: true,
      isFilterable: { $ne: false },
    })
      .select('_id slug')
      .lean();

    const specConds = [];
    specDocs.forEach((attr) => {
      const wanted = String(attrParams[attr.slug]).split(',').map((s) => s.trim()).filter(Boolean);
      if (wanted.length === 0) return;
      specConds.push({ specs: { $elemMatch: { attribute: attr._id, valueSlug: { $in: wanted } } } });
    });
    if (specConds.length) productMatch.$and = specConds;
  }

  const matchedProducts = await Products.find(productMatch)
    .select(
      '_id name slug brand category images variantAttributes pricing hasVariants ratingAverage ratingCount soldCount createdAt'
    )
    .lean();
  const productIds = matchedProducts.map((p) => p._id);

  if (productIds.length === 0) {
    return { categoryDoc, matchedProducts: [], filteredVariants: [] };
  }

  const variants = await ProductVariants.find({ product: { $in: productIds }, isActive: true })
    .select('_id product sku attributes image pricing isDefault')
    .lean();

  // ----- Lọc theo THUỘC TÍNH BIẾN THỂ: lọc trên biến thể -----
  const attributeIdsInScope = [
    ...new Set(matchedProducts.flatMap((p) => (p.variantAttributes || []).map((a) => a.toString()))),
  ];
  const attributeDocs = await Attributes.find({
    _id: { $in: attributeIdsInScope },
    isActive: true,
    type: { $ne: 'spec' },
  }).lean();
  const attrSlugToDoc = new Map(attributeDocs.map((a) => [a.slug, a]));

  let filteredVariants = variants;
  attrKeys.forEach((paramKey) => {
    const attrDoc = attrSlugToDoc.get(paramKey);
    if (!attrDoc) return;
    const wantedSlugs = String(attrParams[paramKey]).split(',').filter(Boolean);
    const wantedValues = attrDoc.values.filter((v) => wantedSlugs.includes(v.slug)).map((v) => v.value);
    if (wantedValues.length === 0) return;
    filteredVariants = filteredVariants.filter((v) =>
      v.attributes.some((a) => a.attribute?.toString() === attrDoc._id.toString() && wantedValues.includes(a.value))
    );
  });

  return { categoryDoc, matchedProducts, filteredVariants };
};

const productClientController = {
  /** GET /products/client/:category */
  getProducts: async (req, res) => {
    try {
      const { categoryDoc, matchedProducts, filteredVariants } = await resolveFilteredData(req);
      if (!categoryDoc) return res.status(404).json({ message: 'Không tìm thấy danh mục' });

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 20));
      const sort = req.query.sort || 'newest';
      const priceRange = parseRange(req.query.price);

      const categoryInfo = { _id: categoryDoc._id, name: categoryDoc.name, slug: categoryDoc.slug };

      if (matchedProducts.length === 0 || filteredVariants.length === 0) {
        return res.json({
          category: categoryInfo,
          products: [],
          pagination: { page, limit, total: 0, totalPages: 1 },
        });
      }

      const brandIds = [...new Set(matchedProducts.filter((p) => p.brand).map((p) => p.brand.toString()))];
      const brandDocs = await Brands.find({ _id: { $in: brandIds } }).select('name slug').lean();
      const brandMap = new Map(brandDocs.map((b) => [b._id.toString(), { _id: b._id, name: b.name, slug: b.slug }]));

      const invMap = await loadInventoryMap(filteredVariants.map((v) => v._id));
      const variantsByProduct = groupBy(filteredVariants, (v) => v.product.toString());
      const now = new Date();

      const items = [];
      for (const product of matchedProducts) {
        if (!hasValidPricing(product.pricing)) continue; // dữ liệu thiếu giá: bỏ qua

        const productVariants = variantsByProduct.get(product._id.toString()) || [];
        if (productVariants.length === 0) continue;

        const entries = buildEntries(productVariants, product, invMap, now);
        const inStock = entries.filter((e) => e.available > 0);
        const available = inStock.length > 0;

        // Còn hàng: tính giá trên biến thể còn hàng. Hết hàng: vẫn hiện (badge "Hết hàng") với giá của mọi biến thể.
        let pool = available ? inStock : entries;

        if (priceRange) {
          pool = pool.filter((e) => e.info.effectivePrice >= priceRange.min && e.info.effectivePrice <= priceRange.max);
          if (pool.length === 0) continue;
        }

        items.push(buildCard(product, pool, brandMap.get(product.brand?.toString()) || null, available));
      }

      /* ----- Sắp xếp: hết hàng luôn xuống cuối ----- */
      const sorters = {
        'price-asc': (a, b) => a.price.min - b.price.min,
        'price-desc': (a, b) => b.price.min - a.price.min,
        newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        bestseller: (a, b) => b.soldCount - a.soldCount,
        rating: (a, b) => b.ratingAverage - a.ratingAverage,
      };
      items.sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return (sorters[sort] || sorters.newest)(a, b);
      });

      const total = items.length;
      const start = (page - 1) * limit;

      return res.json({
        category: categoryInfo,
        products: items.slice(start, start + limit),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
      });
    } catch (error) {
      console.error('Error in getProducts:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },

  /**
   * GET /products/client/search?q=iphone&page=1&limit=20
   * Tìm theo searchKey (tên + thương hiệu + danh mục + tags, đã bỏ dấu) hoặc theo SKU biến thể.
   * Mỗi từ khoá phải xuất hiện trong searchKey. Dùng cho cả dropdown gợi ý (limit nhỏ) lẫn trang kết quả.
   */
  searchProducts: async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 20));
      const rawQ = String(req.query.q || '').trim();
      const q = normalize(rawQ);
      const empty = { keyword: rawQ, products: [], pagination: { page, limit, total: 0, totalPages: 1 } };
      if (q.length < 2) return res.json(empty);

      const tokens = q.split(' ').slice(0, 6);

      // Tìm thêm theo SKU (khách/nhân viên hay gõ mã)
      const idsBySku = await ProductVariants.find({
        isActive: true,
        sku: new RegExp(escapeRegex(rawQ.toUpperCase())),
      }).distinct('product');

      const products = await Products.find({
        status: 'active',
        deletedAt: null,
        'pricing.price': { $type: 'number' },
        $or: [
          { $and: tokens.map((t) => ({ searchKey: { $regex: escapeRegex(t) } })) },
          { _id: { $in: idsBySku } },
        ],
      })
        .select('_id name slug brand images pricing ratingAverage ratingCount soldCount createdAt searchKey')
        .limit(200)
        .lean();

      if (products.length === 0) return res.json(empty);

      const variants = await ProductVariants.find({
        product: { $in: products.map((p) => p._id) },
        isActive: true,
      })
        .select('_id product image attributes pricing')
        .lean();

      const [invMap, brandDocs] = await Promise.all([
        loadInventoryMap(variants.map((v) => v._id)),
        Brands.find({ _id: { $in: products.filter((p) => p.brand).map((p) => p.brand) } })
          .select('name slug')
          .lean(),
      ]);
      const brandMap = new Map(brandDocs.map((b) => [b._id.toString(), { _id: b._id, name: b.name, slug: b.slug }]));
      const variantsByProduct = groupBy(variants, (v) => v.product.toString());
      const now = new Date();

      const items = [];
      for (const product of products) {
        if (!hasValidPricing(product.pricing)) continue; // dữ liệu thiếu giá: bỏ qua

        const entries = buildEntries(variantsByProduct.get(product._id.toString()) || [], product, invMap, now);
        if (entries.length === 0) continue;

        const inStock = entries.filter((e) => e.available > 0);
        const available = inStock.length > 0;

        // Còn hàng: tính giá trên biến thể còn hàng. Hết hàng: vẫn hiện (badge "Hết hàng").
        const card = buildCard(
          product,
          available ? inStock : entries,
          brandMap.get(product.brand?.toString()) || null,
          available
        );

        // Điểm liên quan: bắt đầu bằng cụm từ khoá (2) > chứa nguyên cụm (1) > chỉ chứa từng từ (0)
        const key = product.searchKey || '';
        card._score = key.startsWith(q) ? 2 : key.includes(q) ? 1 : 0;
        items.push(card);
      }

      // Còn hàng lên trước -> liên quan -> bán chạy
      items.sort((a, b) => b.available - a.available || b._score - a._score || b.soldCount - a.soldCount);
      items.forEach((i) => delete i._score);

      const total = items.length;
      const start = (page - 1) * limit;

      return res.json({
        keyword: rawQ,
        products: items.slice(start, start + limit),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
      });
    } catch (error) {
      console.error('Error in searchProducts:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },

  /**
   * GET /products/client/detail/:slug
   * - product.price: giá của SẢN PHẨM -> hiển thị khi chưa chọn biến thể.
   * - variants[].price: giá của TỪNG BIẾN THỂ (đã kế thừa product nếu không có giá riêng)
   *   -> chỉ hiển thị khi người dùng chọn biến thể đó.
   * - defaultVariantId: chỉ có giá trị với sản phẩm KHÔNG có biến thể (để thêm vào giỏ).
   * - options: thuộc tính SINH biến thể (ô chọn Màu sắc, Dung lượng...).
   * - specs: thông số kỹ thuật (thuộc tính KHÔNG sinh biến thể) -> bảng thông số.
   *   Mỗi phần tử gồm `value` (các giá trị nối bằng ", ") và `values` (mảng) cho thuộc tính chọn nhiều.
   * - hasAccessories: có sản phẩm đi kèm hay không -> FE gọi GET /products/client/accessories/:slug.
   */
  getProductDetail: async (req, res) => {
    try {
      const { slug } = req.params;

      const product = await Products.findOne({ slug, status: 'active', deletedAt: null }).lean();
      if (!product) return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });

      const [brandDoc, categoryDoc, variants] = await Promise.all([
        product.brand ? Brands.findById(product.brand).select('name slug').lean() : null,
        product.category ? Categorys.findById(product.category).select('name slug').lean() : null,
        ProductVariants.find({ product: product._id, isActive: true })
          .select('_id sku attributes image pricing isDefault')
          .lean(),
      ]);

      if (variants.length === 0) {
        return res.status(404).json({ message: 'Sản phẩm chưa có biến thể' });
      }

      const invMap = await loadInventoryMap(variants.map((v) => v._id));
      const now = new Date();
      // Giá giờ vàng đang áp dụng (đã trừ suất đã hết / hạn mức khách này đã dùng); không có -> null
      const flashMap = await getFlashPricingMap(variants.map((v) => v._id), req.user?._id ?? null, now);

      const variantList = buildEntries(variants, product, invMap, now).map(({ variant, info, available }) => ({
        _id: variant._id,
        sku: variant.sku,
        image: variant.image?.url || '',
        attributes: (variant.attributes || []).map((a) => ({
          attribute: a.attribute,
          attributeName: a.attributeName,
          value: a.value,
        })),
        price: info,
        // { itemId, flashPrice, remaining, maxQuantity, endTime } | null
        flash: flashMap.get(String(variant._id)) ?? null,
        available: available > 0,
        availableQuantity: available,
      }));

      /* ----- Nhóm lựa chọn (Màu sắc, Dung lượng...) + giá trị nào còn hàng ----- */
      const optionMap = new Map(); // attributeName -> Map(value -> available)
      variantList.forEach((v) => {
        v.attributes.forEach((a) => {
          if (!optionMap.has(a.attributeName)) optionMap.set(a.attributeName, new Map());
          const values = optionMap.get(a.attributeName);
          values.set(a.value, values.get(a.value) || v.available);
        });
      });
      const options = [...optionMap.entries()].map(([name, values]) => ({
        name,
        values: [...values.entries()].map(([value, available]) => ({ value, available })),
      }));

      /* ----- Thông số kỹ thuật (giữ thứ tự admin đã nhập, gộp nhiều giá trị cùng thuộc tính) ----- */
      const specMap = new Map();
      (product.specs || []).forEach((s) => {
        const key = String(s.attribute);
        if (!specMap.has(key)) specMap.set(key, { attribute: s.attribute, name: s.attributeName, values: [] });
        specMap.get(key).values.push(s.value);
      });
      const specs = [...specMap.values()].map((s) => ({
        ...s,
        value: s.values.join(', '), // giữ `value` để FE cũ vẫn chạy
      }));

      const defaultVariant = product.hasVariants
        ? null
        : variants.find((v) => v.isDefault) || variants[0];

      return res.json({
        product: {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          description: product.description || '',
          shortDescription: product.shortDescription || '',
          images: product.images || [],
          video: product.video?.videoId
            ? { youtubeUrl: product.video.youtubeUrl, videoId: product.video.videoId }
            : null,
          brand: brandDoc ? { _id: brandDoc._id, name: brandDoc.name, slug: brandDoc.slug } : null,
          category: categoryDoc ? { _id: categoryDoc._id, name: categoryDoc.name, slug: categoryDoc.slug } : null,
          ratingAverage: product.ratingAverage,
          ratingCount: product.ratingCount,
          soldCount: product.soldCount,
          createdAt: product.createdAt,
          hasVariants: product.hasVariants,
          warrantyMonths: product.warrantyMonths ?? 0,
          hasAccessories: (product.accessories || []).length > 0, // MỚI
          available: variantList.some((v) => v.available),
          price: buildPriceInfo(product.pricing, now), // giá sản phẩm
          priceRange: { min: product.priceMin, max: product.priceMax }, // "Từ X - Y" nếu muốn hiển thị
          defaultVariantId: defaultVariant ? defaultVariant._id : null,
          options,
          specs,
          variants: variantList,
        },
      });
    } catch (error) {
      console.error('Error in getProductDetail:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },

  /**
   * MỚI: GET /products/client/accessories/:slug?limit=12
   * Sản phẩm đi kèm do admin chọn. Chỉ trả món đang bán (active, chưa xoá) và còn hàng khả dụng,
   * giữ đúng thứ tự admin sắp xếp.
   * Mỗi card có thêm: hasVariants, defaultVariantId (khác null -> thêm thẳng vào giỏ; null -> khách chọn biến thể).
   */
  getAccessories: async (req, res) => {
    try {
      const { slug } = req.params;
      const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 12));

      const current = await Products.findOne({ slug, status: 'active', deletedAt: null })
        .select('_id accessories')
        .lean();
      if (!current) return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });

      const ids = current.accessories || [];
      if (ids.length === 0) return res.json({ products: [] });

      const candidates = await Products.find({
        _id: { $in: ids },
        status: 'active',
        deletedAt: null,
        'pricing.price': { $type: 'number' },
      })
        .select('_id name slug brand images pricing hasVariants ratingAverage ratingCount soldCount createdAt')
        .lean();
      if (candidates.length === 0) return res.json({ products: [] });

      const variants = await ProductVariants.find({
        product: { $in: candidates.map((p) => p._id) },
        isActive: true,
      })
        .select('_id product image attributes pricing isDefault')
        .lean();

      const [invMap, brandDocs] = await Promise.all([
        loadInventoryMap(variants.map((v) => v._id)),
        Brands.find({ _id: { $in: candidates.filter((p) => p.brand).map((p) => p.brand) } })
          .select('name slug')
          .lean(),
      ]);
      const brandMap = new Map(brandDocs.map((b) => [b._id.toString(), { _id: b._id, name: b.name, slug: b.slug }]));
      const variantsByProduct = groupBy(variants, (v) => v.product.toString());
      const order = new Map(ids.map((id, i) => [String(id), i]));
      const now = new Date();

      const items = [];
      for (const product of candidates) {
        if (!hasValidPricing(product.pricing)) continue;

        const entries = buildEntries(variantsByProduct.get(product._id.toString()) || [], product, invMap, now);
        const inStock = entries.filter((e) => e.available > 0);
        if (inStock.length === 0) continue; // hết hàng thì không gợi ý mua kèm

        const card = buildCard(product, inStock, brandMap.get(product.brand?.toString()) || null, true);
        const defaultEntry = product.hasVariants ? null : inStock.find((e) => e.variant.isDefault) || inStock[0];

        items.push({
          ...card,
          hasVariants: product.hasVariants,
          defaultVariantId: defaultEntry ? defaultEntry.variant._id : null,
          _order: order.get(String(product._id)) ?? 0,
        });
      }

      items.sort((a, b) => a._order - b._order);
      items.forEach((i) => delete i._order);

      return res.json({ products: items.slice(0, limit) });
    } catch (error) {
      console.error('Error in getAccessories:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },

  /** GET /products/client/best-sellers?filter=all|bestseller|new|best-price&category=slug&limit=8 */
  getBestSellers: async (req, res) => {
    try {
      const { category } = req.query;
      const filter = req.query.filter || 'all';
      const DB_SORTS = {
        all: { soldCount: -1, ratingAverage: -1, createdAt: -1 },
        bestseller: { soldCount: -1, ratingAverage: -1, createdAt: -1 },
        new: { createdAt: -1, soldCount: -1 },
        'best-price': { soldCount: -1, ratingAverage: -1 }, // chỉ để chọn nhóm ứng viên, sắp xếp thật ở bước cuối
      };
      if (!DB_SORTS[filter]) return res.status(400).json({ message: 'filter không hợp lệ' });

      const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 8));

      /* ----- 1. Sản phẩm có ít nhất 1 biến thể còn hàng khả dụng trong kho tổng ----- */
      const stockedGroups = await Inventory.aggregate([
        { $match: { isActive: true, $expr: { $gt: ['$quantity', '$reservedQuantity'] } } },
        { $group: { _id: '$product' } },
      ]);
      const stockedProductIds = stockedGroups.map((g) => g._id);

      const emptyResponse = (categoryInfo = null) => res.json({ category: categoryInfo, filter, products: [] });

      if (stockedProductIds.length === 0) return emptyResponse();

      /* ----- 2. Lọc sản phẩm & chọn nhóm ứng viên ----- */
      const productMatch = {
        _id: { $in: stockedProductIds },
        status: 'active',
        deletedAt: null,
        'pricing.price': { $type: 'number' }, // bỏ product chưa có giá (dữ liệu cũ)
      };
      if (filter === 'bestseller') productMatch.soldCount = { $gt: 0 };

      let categoryInfo = null;
      if (category) {
        const categoryDoc = await Categorys.findOne({ slug: category, isActive: true }).lean();
        if (!categoryDoc) return res.status(404).json({ message: 'Không tìm thấy danh mục' });
        const children = await Categorys.find({ parent: categoryDoc._id }).select('_id').lean();
        productMatch.category = { $in: [categoryDoc._id, ...children.map((c) => c._id)] };
        categoryInfo = { _id: categoryDoc._id, name: categoryDoc.name, slug: categoryDoc.slug };
      }

      // best-price cần tính giá rồi mới sắp xếp -> lấy nhóm ứng viên lớn hơn (tối đa 100)
      const candidateLimit = filter === 'best-price' ? 100 : limit * 3;

      const candidates = await Products.find(productMatch)
        .sort(DB_SORTS[filter])
        .limit(candidateLimit)
        .select('_id name slug brand images pricing ratingAverage ratingCount soldCount createdAt')
        .lean();

      if (candidates.length === 0) return emptyResponse(categoryInfo);

      /* ----- 3. Biến thể + tồn kho (chỉ cho các ứng viên) ----- */
      const variants = await ProductVariants.find({ product: { $in: candidates.map((p) => p._id) }, isActive: true })
        .select('_id product image attributes pricing')
        .lean();

      const [invMap, brandDocs] = await Promise.all([
        loadInventoryMap(variants.map((v) => v._id)),
        Brands.find({ _id: { $in: candidates.filter((p) => p.brand).map((p) => p.brand) } })
          .select('name slug')
          .lean(),
      ]);
      const brandMap = new Map(brandDocs.map((b) => [b._id.toString(), { _id: b._id, name: b.name, slug: b.slug }]));
      const variantsByProduct = groupBy(variants, (v) => v.product.toString());

      /* ----- 4. Dựng kết quả ----- */
      const now = new Date();
      let products = [];

      for (const product of candidates) {
        if (!hasValidPricing(product.pricing)) continue; // dữ liệu thiếu giá: bỏ qua

        const pool = buildEntries(variantsByProduct.get(product._id.toString()) || [], product, invMap, now).filter(
          (e) => e.available > 0
        );
        if (pool.length === 0) continue;

        products.push(buildCard(product, pool, brandMap.get(product.brand?.toString()) || null, true));

        if (filter !== 'best-price' && products.length >= limit) break;
      }

      if (filter === 'best-price') {
        products.sort((a, b) => b.discountPercent - a.discountPercent || a.price.min - b.price.min);
      }
      products = products.slice(0, limit);

      return res.json({ category: categoryInfo, filter, products });
    } catch (error) {
      console.error('Error in getBestSellers:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },

  /**
   * GET /products/client/related/:slug?limit=8
   * Sản phẩm cùng danh mục (loại trừ chính nó). Ưu tiên: còn hàng -> cùng thương hiệu -> bán chạy.
   */
  getRelatedProducts: async (req, res) => {
    try {
      const { slug } = req.params;
      const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));

      const current = await Products.findOne({ slug, status: 'active', deletedAt: null })
        .select('_id category brand')
        .lean();
      if (!current) return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });

      const candidates = await Products.find({
        _id: { $ne: current._id },
        category: current.category,
        status: 'active',
        deletedAt: null,
        'pricing.price': { $type: 'number' },
      })
        .sort({ soldCount: -1, ratingAverage: -1 })
        .limit(limit * 4)
        .select('_id name slug brand images pricing ratingAverage ratingCount soldCount createdAt')
        .lean();

      if (candidates.length === 0) return res.json({ products: [] });

      const variants = await ProductVariants.find({
        product: { $in: candidates.map((p) => p._id) },
        isActive: true,
      })
        .select('_id product image attributes pricing')
        .lean();

      const [invMap, brandDocs] = await Promise.all([
        loadInventoryMap(variants.map((v) => v._id)),
        Brands.find({ _id: { $in: candidates.filter((p) => p.brand).map((p) => p.brand) } })
          .select('name slug')
          .lean(),
      ]);
      const brandMap = new Map(brandDocs.map((b) => [b._id.toString(), { _id: b._id, name: b.name, slug: b.slug }]));
      const variantsByProduct = groupBy(variants, (v) => v.product.toString());
      const now = new Date();

      const items = [];
      for (const product of candidates) {
        if (!hasValidPricing(product.pricing)) continue;

        const entries = buildEntries(variantsByProduct.get(product._id.toString()) || [], product, invMap, now);
        if (entries.length === 0) continue;

        const inStock = entries.filter((e) => e.available > 0);
        const available = inStock.length > 0;

        const card = buildCard(
          product,
          available ? inStock : entries,
          brandMap.get(product.brand?.toString()) || null,
          available
        );
        card._sameBrand =
          current.brand && product.brand && current.brand.toString() === product.brand.toString() ? 1 : 0;
        items.push(card);
      }

      items.sort(
        (a, b) => b.available - a.available || b._sameBrand - a._sameBrand || b.soldCount - a.soldCount
      );
      items.forEach((i) => delete i._sameBrand);

      return res.json({ products: items.slice(0, limit) });
    } catch (error) {
      console.error('Error in getRelatedProducts:', error);
      res.status(500).json({ message: 'Internal Server Error' });
    }
  },
};

export default productClientController;