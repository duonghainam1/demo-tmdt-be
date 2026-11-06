import Categorys from '../../models/categories/categoryModel.js';
import Brands from '../../models/products/brandModel.js';
import Attributes from '../../models/products/attributeModel.js';
import Products from '../../models/products/productModel.js';
import ProductVariants from '../../models/products/productVariantModel.js';

// Lấy id danh mục hiện tại + toàn bộ danh mục con (mọi cấp)
const getCategoryTreeIds = async (rootId) => {
  const ids = [rootId];
  let queue = [rootId];

  while (queue.length) {
    const children = await Categorys.find({
      parent: { $in: queue },
      isActive: true,
    })
      .select('_id')
      .lean();

    queue = children.map((c) => c._id);
    ids.push(...queue);
  }
  return ids;
};

const PRICE_PRESETS = [
  { label: 'Dưới 300k', min: 0, max: 300000 },
  { label: '300k - 600k', min: 300000, max: 600000 },
  { label: '600k - 1 triệu', min: 600000, max: 1000000 },
  { label: 'Trên 1 triệu', min: 1000000, max: null },
];

const MAX_TAGS = 30; // số tag tối đa trả về cho bộ lọc

/**
 * GET /products/client/filters/:slug
 * Trả về:
 *  - brands, priceRange, tags
 *  - attributes: thuộc tính SINH BIẾN THỂ (lọc trên biến thể)  -> ?<attr.slug>=<value.slug,...>
 *  - specs     : thông số KHÔNG sinh biến thể (lọc trên sản phẩm) -> ?<attr.slug>=<value.slug,...>
 * Chỉ trả thuộc tính đang hoạt động, có isFilterable != false và có ít nhất 1 sản phẩm dùng.
 */
export const getFiltersByCategory = async (req, res) => {
  try {
    const { slug } = req.params;

    const category = await Categorys.findOne({ slug, isActive: true })
      .select('name slug parent')
      .lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy danh mục',
      });
    }

    const categoryIds = await getCategoryTreeIds(category._id);

    const [facets] = await Products.aggregate([
      {
        $match: {
          category: { $in: categoryIds },
          status: 'active',
          deletedAt: null,
          // Khớp với API danh sách sản phẩm: bỏ sản phẩm chưa có giá
          'pricing.price': { $type: 'number' },
        },
      },
      {
        $facet: {
          // Danh sách id sản phẩm trong phạm vi -> dùng để quét biến thể bên dưới
          ids: [{ $group: { _id: null, ids: { $push: '$_id' } } }],
          brands: [
            { $match: { brand: { $ne: null } } },
            { $group: { _id: '$brand', count: { $sum: 1 } } },
          ],
          price: [
            {
              $group: {
                _id: null,
                min: { $min: '$priceMin' },
                max: { $max: '$priceMax' },
                total: { $sum: 1 },
              },
            },
          ],
          // ---------- TAGS ----------
          tags: [
            { $match: { tags: { $exists: true, $ne: [] } } },
            // Mỗi sản phẩm chỉ đếm 1 lần cho mỗi tag (dù tag bị lặp trong mảng)
            {
              $project: {
                tags: {
                  $setUnion: [
                    {
                      $map: {
                        input: '$tags',
                        as: 't',
                        in: { $trim: { input: '$$t' } },
                      },
                    },
                    [],
                  ],
                },
              },
            },
            { $unwind: '$tags' },
            { $match: { tags: { $ne: '' } } },
            { $group: { _id: '$tags', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: MAX_TAGS },
          ],
          // ---------- SPECS (thông số không sinh biến thể) ----------
          // Mỗi sản phẩm chỉ có tối đa 1 giá trị cho mỗi thuộc tính spec -> $sum: 1 = số sản phẩm
          specs: [
            { $match: { 'specs.0': { $exists: true } } },
            { $unwind: '$specs' },
            { $match: { 'specs.valueSlug': { $nin: [null, ''] } } },
            {
              $group: {
                _id: { attribute: '$specs.attribute', valueSlug: '$specs.valueSlug' },
                value: { $first: '$specs.value' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const productIds = facets.ids[0]?.ids || [];

    // ---------- BRANDS ----------
    const brandCountMap = new Map(
      facets.brands.map((b) => [String(b._id), b.count])
    );

    const brands = await Brands.find({
      _id: { $in: facets.brands.map((b) => b._id) },
      isActive: true,
    })
      .select('name slug logo')
      .sort({ name: 1 })
      .lean();

    const brandFilter = brands.map((b) => ({
      _id: b._id,
      name: b.name,
      slug: b.slug,
      logo: b.logo?.url || '',
      count: brandCountMap.get(String(b._id)) || 0,
    }));

    // ---------- ATTRIBUTES (sinh biến thể) ----------
    // Quét BIẾN THỂ đang bán của các sản phẩm trong danh mục, gom theo (thuộc tính, giá trị)
    // -> chỉ những giá trị thật sự có sản phẩm mới được trả về.
    const usedValues = productIds.length
      ? await ProductVariants.aggregate([
          { $match: { product: { $in: productIds }, isActive: true } },
          { $unwind: '$attributes' },
          {
            $group: {
              _id: {
                attribute: '$attributes.attribute',
                valueId: '$attributes.valueId',
                value: '$attributes.value',
              },
              products: { $addToSet: '$product' }, // đếm theo sản phẩm, không đếm theo biến thể
            },
          },
          {
            $project: {
              _id: 0,
              attribute: '$_id.attribute',
              valueId: '$_id.valueId',
              value: '$_id.value',
              count: { $size: '$products' },
            },
          },
        ])
      : [];

    // attributeId -> [{ valueId, value, count }]
    const usedByAttr = new Map();
    usedValues.forEach((u) => {
      const key = String(u.attribute);
      if (!usedByAttr.has(key)) usedByAttr.set(key, []);
      usedByAttr.get(key).push(u);
    });

    const attributes = await Attributes.find({
      _id: { $in: [...usedByAttr.keys()] },
      isActive: true,
      type: { $ne: 'spec' }, // dữ liệu cũ chưa có type vẫn là 'variant'
      isFilterable: { $ne: false },
    })
      .select('name slug values')
      .sort({ name: 1 })
      .lean();

    const attributeFilter = attributes
      .map((attr) => {
        const used = usedByAttr.get(String(attr._id)) || [];
        const byId = new Map(used.map((u) => [String(u.valueId), u]));
        const byText = new Map(used.map((u) => [u.value, u]));

        // Duyệt theo thứ tự giá trị đã khai báo trong Attribute để giữ thứ tự ổn định
        const values = (attr.values || [])
          .map((v) => {
            const hit = byId.get(String(v._id)) || byText.get(v.value);
            if (!hit) return null; // giá trị này không có sản phẩm nào -> bỏ
            return { _id: v._id, value: v.value, slug: v.slug, count: hit.count };
          })
          .filter(Boolean);

        return {
          _id: attr._id,
          name: attr.name,
          slug: attr.slug,
          // số sản phẩm có ít nhất 1 giá trị của thuộc tính này
          count: values.reduce((max, v) => Math.max(max, v.count), 0),
          values,
        };
      })
      .filter((attr) => attr.values.length > 0); // nhóm rỗng -> không hiện

    // ---------- SPECS (không sinh biến thể) ----------
    const usedSpecByAttr = new Map();
    facets.specs.forEach((s) => {
      const key = String(s._id.attribute);
      if (!usedSpecByAttr.has(key)) usedSpecByAttr.set(key, []);
      usedSpecByAttr.get(key).push({ slug: s._id.valueSlug, value: s.value, count: s.count });
    });

    const specAttributes = usedSpecByAttr.size
      ? await Attributes.find({
          _id: { $in: [...usedSpecByAttr.keys()] },
          type: 'spec',
          isActive: true,
          isFilterable: { $ne: false },
        })
          .select('name slug inputType values')
          .sort({ name: 1 })
          .lean()
      : [];

    const specFilter = specAttributes
      .map((attr) => {
        const used = usedSpecByAttr.get(String(attr._id)) || [];

        let values;
        if (attr.inputType === 'text') {
          // Nhập tay: không có thứ tự khai báo -> nhiều sản phẩm nhất lên trước
          values = used
            .map((u) => ({ value: u.value, slug: u.slug, count: u.count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'vi'));
        } else {
          // Chọn từ danh sách: giữ thứ tự đã khai báo trong Attribute
          const bySlug = new Map(used.map((u) => [u.slug, u]));
          values = (attr.values || [])
            .map((v) => {
              const hit = bySlug.get(v.slug);
              return hit ? { _id: v._id, value: v.value, slug: v.slug, count: hit.count } : null;
            })
            .filter(Boolean);
        }

        return {
          _id: attr._id,
          name: attr.name,
          slug: attr.slug,
          inputType: attr.inputType || 'select',
          count: values.reduce((sum, v) => sum + v.count, 0),
          values,
        };
      })
      .filter((attr) => attr.values.length > 0);

    // ---------- TAGS ----------
    const tagFilter = facets.tags.map((t) => ({
      value: t._id,
      count: t.count,
    }));

    // ---------- PRICE ----------
    const priceStat = facets.price[0] || { min: 0, max: 0, total: 0 };

    // Chỉ giữ mốc giá có giao với khoảng giá thực tế
    const presets =
      priceStat.total === 0
        ? []
        : PRICE_PRESETS.filter(
            (p) =>
              priceStat.max >= p.min &&
              (p.max === null || priceStat.min < p.max)
          );

    return res.status(200).json({
      success: true,
      data: {
        category: {
          _id: category._id,
          name: category.name,
          slug: category.slug,
        },
        brands: brandFilter,
        priceRange: { min: priceStat.min, max: priceStat.max, presets },
        attributes: attributeFilter,
        specs: specFilter,
        tags: tagFilter,
      },
    });
  } catch (error) {
    console.error('getFiltersByCategory error:', error);
    return res.status(500).json({
      success: false,
      message: 'Lỗi server',
      error: error.message,
    });
  }
};