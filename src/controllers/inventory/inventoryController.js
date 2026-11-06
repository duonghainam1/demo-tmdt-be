import Inventory from "../../models/inventory/inventoryModel.js";
import Products from "../../models/products/productModel.js";
import ProductVariants from "../../models/products/productVariantModel.js";
const VARIANT_POPULATE = 'sku image attributes';
const escapeRegex = (str = '') => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const inventoryController = {
    getAll: async (req, res) => {
    try {
      const { store, product, variant, lowStock, search, page = 1, limit = 20 } = req.query;
 
      const filter = {};
      if (store) filter.store = store;
      if (product) filter.product = product;
      if (variant) filter.variant = variant;
      // lowStock=true -> chỉ lấy các dòng đã chạm/dưới ngưỡng cảnh báo
      if (lowStock === 'true') {
        filter.$expr = { $lte: ['$quantity', '$reorderLevel'] };
      }
 
      // search -> tìm theo tên sản phẩm HOẶC sku/barcode của variant
      if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), 'i');
 
        const [matchedProducts, matchedVariants] = await Promise.all([
          Products.find({ name: regex }).select('_id'),
          ProductVariants.find({ sku: regex }).select('_id'),
        ]);
 
        const productIds = matchedProducts.map((p) => p._id);
        const variantIds = matchedVariants.map((v) => v._id);
 
        if (productIds.length === 0 && variantIds.length === 0) {
          // Không khớp gì -> trả về danh sách rỗng ngay, khỏi query Inventory
          return res.status(200).json({
            message: 'Lấy danh sách tồn kho thành công',
            data: [],
            pagination: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
          });
        }
 
        filter.$or = [{ product: { $in: productIds } }, { variant: { $in: variantIds } }];
      }
 
      const skip = (Number(page) - 1) * Number(limit);
 
      const [items, total] = await Promise.all([
        Inventory.find(filter)
          .populate('variant', VARIANT_POPULATE)
          .populate('store', 'name')
          .populate('product', 'name')
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(Number(limit)),
        Inventory.countDocuments(filter),
      ]);
 
      return res.status(200).json({
        message: 'Lấy danh sách tồn kho thành công',
        data: items,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      return res.status(500).json({ message: 'Lỗi server', error: error.message });
    }
  },
  createOrUpdate: async (req, res) => {
    try {
        console.log('Error in createOrUpdate:', error);
        
    } catch (error) {
        console.log('Error in createOrUpdate:', error);
    }
  }
}
export default inventoryController;