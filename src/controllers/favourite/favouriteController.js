import mongoose from 'mongoose';
import Favourites from '../../models/favourite/favouriteModel.js';
import Products from '../../models/products/productModel.js'; // chỉnh lại đường dẫn cho đúng dự án

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// POST /api/favourites/:productId  -> thêm vào yêu thích (idempotent)
export const addFavourite = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidId(productId)) {
      return res.status(400).json({ success: false, message: 'ID sản phẩm không hợp lệ' });
    }

    const product = await Products.findOne({ _id: productId, deletedAt: null, status: 'active' })
      .select('_id')
      .lean();
    if (!product) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
    }

    // upsert: gọi nhiều lần cũng không tạo trùng, không lỗi race condition
    await Favourites.updateOne(
      { user: req.user._id, product: productId },
      { $setOnInsert: { user: req.user._id, product: productId } },
      { upsert: true }
    );

    res.status(201).json({ success: true, isFavourite: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, isFavourite: true });
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/favourites/:productId  -> bỏ yêu thích
export const removeFavourite = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidId(productId)) {
      return res.status(400).json({ success: false, message: 'ID sản phẩm không hợp lệ' });
    }
    await Favourites.deleteOne({ user: req.user._id, product: productId });
    res.json({ success: true, isFavourite: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/favourites/:productId/toggle  -> bật/tắt (tiện cho nút tim ở FE)
export const toggleFavourite = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!isValidId(productId)) {
      return res.status(400).json({ success: false, message: 'ID sản phẩm không hợp lệ' });
    }

    const removed = await Favourites.findOneAndDelete({ user: req.user._id, product: productId });
    if (removed) return res.json({ success: true, isFavourite: false });

    const product = await Products.findOne({ _id: productId, deletedAt: null, status: 'active' })
      .select('_id')
      .lean();
    if (!product) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
    }

    await Favourites.updateOne(
      { user: req.user._id, product: productId },
      { $setOnInsert: { user: req.user._id, product: productId } },
      { upsert: true }
    );
    res.json({ success: true, isFavourite: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/favourites?page=1&limit=12  -> danh sách yêu thích của tôi
export const getMyFavourites = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);

    const [favourites, total] = await Promise.all([
      Favourites.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: 'product',
          select: 'name slug images pricing priceMin priceMax hasVariants status deletedAt ratingAverage ratingCount soldCount brand category',
          populate: [
            { path: 'brand', select: 'name slug' },
            { path: 'category', select: 'name slug' },
          ],
        }),
      Favourites.countDocuments({ user: req.user._id }),
    ]);

    const items = favourites
      // bỏ sản phẩm đã xóa mềm / ngừng bán
      .filter((f) => f.product && !f.product.deletedAt && f.product.status === 'active')
      .map((f) => {
        const p = f.product;
        let priceInfo = null;
        try { priceInfo = p.getPriceInfo(); } catch { /* bỏ qua nếu thiếu pricing */ }
        return {
          favouriteId: f._id,
          likedAt: f.createdAt,
          product: {
            _id: p._id,
            name: p.name,
            slug: p.slug,
            image: p.images?.[0]?.url || '',
            hasVariants: p.hasVariants,
            priceMin: p.priceMin,
            priceMax: p.priceMax,
            priceInfo,
            brand: p.brand,
            category: p.category,
            ratingAverage: p.ratingAverage,
            ratingCount: p.ratingCount,
            soldCount: p.soldCount,
          },
        };
      });

    res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/favourites/check  body: { productIds: [...] }
// -> FE gửi danh sách sản phẩm đang hiển thị, nhận về cái nào đã thích để tô tim
export const checkFavourites = async (req, res) => {
  try {
    const ids = (req.body.productIds || []).filter(isValidId).slice(0, 100);
    const favs = await Favourites.find({ user: req.user._id, product: { $in: ids } })
      .select('product')
      .lean();
    res.json({ success: true, favouriteIds: favs.map((f) => String(f.product)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/favourites  -> xóa toàn bộ yêu thích của tôi
export const clearFavourites = async (req, res) => {
  try {
    await Favourites.deleteMany({ user: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/favourites/ids  -> toàn bộ id sản phẩm tôi đã thích (để tô tim ở mọi trang)
export const getFavouriteIds = async (req, res) => {
  try {
    const favs = await Favourites.find({ user: req.user._id }).select('product').lean();
    res.json({ success: true, favouriteIds: favs.map((f) => String(f.product)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};