import mongoose from 'mongoose';

/**
 * Đánh giá sản phẩm sau khi mua.
 * - Mỗi (đơn hàng + biến thể) chỉ được đánh giá 1 lần  -> unique index { order, variant }
 * - Snapshot thuộc tính biến thể để hiển thị "Phân loại: Đen / 256GB" dù sản phẩm đổi sau này
 * - Ảnh lưu { url, publicId } khớp với cách bạn lưu ảnh sản phẩm (Cloudinary)
 */
const reviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Products', required: true, index: true },
    variant: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariants', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders', required: true },

    // Snapshot để hiển thị
    variantAttributes: [
      {
        _id: false,
        name: { type: String, required: true },
        value: { type: String, required: true },
      },
    ],

    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '', trim: true, maxlength: 1000 },
    images: [
      {
        _id: false,
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
      },
    ],

    // Admin có thể ẩn đánh giá vi phạm (không xóa hẳn). Chỉ 'visible' mới tính vào điểm sao.
    status: { type: String, enum: ['visible', 'hidden'], default: 'visible', index: true },

    // Phản hồi của cửa hàng
    reply: {
      content: { type: String, default: '', trim: true, maxlength: 500 },
      repliedAt: { type: Date, default: null },
      repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
    },

    // Khách chỉ được sửa 1 lần
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// 1 dòng hàng trong 1 đơn chỉ đánh giá 1 lần
reviewSchema.index({ order: 1, variant: 1 }, { unique: true });
// Danh sách đánh giá của 1 sản phẩm (mới nhất trước) + lọc theo sao
reviewSchema.index({ product: 1, status: 1, createdAt: -1 });
reviewSchema.index({ product: 1, status: 1, rating: 1 });

/**
 * Tính lại ratingAverage / ratingCount của sản phẩm từ các đánh giá đang hiển thị.
 * Gọi sau mỗi lần: tạo, sửa, ẩn/hiện, xoá đánh giá.
 */
reviewSchema.statics.recalcProductRating = async function (productId) {
  const Products = mongoose.model('Products');
  const [agg] = await this.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)), status: 'visible' } },
    { $group: { _id: '$product', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Products.updateOne(
    { _id: productId },
    {
      ratingAverage: agg ? Math.round(agg.avg * 10) / 10 : 0,
      ratingCount: agg ? agg.count : 0,
    },
    { timestamps: false } // đổi điểm sao không làm đổi updatedAt của sản phẩm
  );
};

const Reviews = mongoose.model('Reviews', reviewSchema);
export default Reviews;