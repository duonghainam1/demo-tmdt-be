import mongoose from 'mongoose';

const favouriteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Products', required: true },
  },
  { timestamps: true }
);

// Mỗi user chỉ thích 1 sản phẩm 1 lần
favouriteSchema.index({ user: 1, product: 1 }, { unique: true });
// Lấy danh sách yêu thích của user, mới nhất trước
favouriteSchema.index({ user: 1, createdAt: -1 });
// Đếm lượt thích theo sản phẩm
favouriteSchema.index({ product: 1 });

const Favourites = mongoose.model('Favourites', favouriteSchema);
export default Favourites;