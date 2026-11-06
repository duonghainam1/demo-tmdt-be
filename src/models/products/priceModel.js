// import mongoose from 'mongoose';

// const priceHistorySchema = new mongoose.Schema(
//   {
//     price: { type: Number, required: true, min: 0 },
//     compareAtPrice: { type: Number, default: 0, min: 0 },
//     costPrice: { type: Number, default: 0, min: 0 },
//     salePrice: { type: Number, default: null, min: 0 },
//     note: { type: String, default: '', trim: true },
//     changedAt: { type: Date, default: Date.now },
//   },
//   { _id: false }
// );

// const priceSchema = new mongoose.Schema(
//   {
//     variant: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'ProductVariants',
//       required: true,
//       index: true,
//     },
//     product: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Products',
//       required: true,
//     },
//     store: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: 'Stores',
//       required: true,
//     },

//     price: { type: Number, required: true, min: 0 },
//     compareAtPrice: { type: Number, default: 0, min: 0 },
//     costPrice: { type: Number, default: 0, min: 0 },
//     salePrice: { type: Number, default: null, min: 0 },
//     currency: { type: String, default: 'VND', uppercase: true, trim: true },

//     saleStartDate: { type: Date, default: null },
//     saleEndDate: { type: Date, default: null },

//     /**
//      * Cho phép admin tạm ngừng bán sản phẩm này TẠI RIÊNG cửa hàng này
//      * mà không cần xóa dữ liệu giá. Khi query hiển thị sản phẩm, luôn
//      * lọc thêm điều kiện isActive: true.
//      */
//     isActive: { type: Boolean, default: true, index: true },

//     history: { type: [priceHistorySchema], default: [] },
//   },
//   { timestamps: true }
// );

// priceSchema.index({ variant: 1, store: 1 }, { unique: true });
// priceSchema.index({ product: 1 });
// priceSchema.index({ store: 1 });
// priceSchema.index({ store: 1, isActive: 1 });

// priceSchema.methods.isSaleActive = function (now = new Date()) {
//   if (this.salePrice == null) return false;
//   if (!this.saleStartDate || !this.saleEndDate) return false;
//   return now >= this.saleStartDate && now <= this.saleEndDate;
// };

// priceSchema.methods.getEffectivePrice = function (now = new Date()) {
//   return this.isSaleActive(now) ? this.salePrice : this.price;
// };

// priceSchema.methods.getPriceInfo = function (now = new Date()) {
//   const saleActive = this.isSaleActive(now);
//   return {
//     price: this.price,
//     compareAtPrice: this.compareAtPrice,
//     costPrice: this.costPrice,
//     salePrice: this.salePrice,
//     effectivePrice: saleActive ? this.salePrice : this.price,
//     isSaleActive: saleActive,
//     currency: this.currency,
//     saleStartDate: this.saleStartDate,
//     saleEndDate: this.saleEndDate,
//   };
// };

// const Prices = mongoose.model('Prices', priceSchema);
// export default Prices;