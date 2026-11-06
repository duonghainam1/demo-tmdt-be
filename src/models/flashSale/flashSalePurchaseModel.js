import mongoose from 'mongoose';

const flashSalePurchaseSchema = new mongoose.Schema(
  {
    flashSaleItem: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashSaleItems', required: true },
    flashSale: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashSales', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders', required: true },

    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['reserved', 'completed', 'released'],
      default: 'reserved',
    },
  },
  { timestamps: true }
);

// Mỗi đơn chỉ có 1 bản ghi cho mỗi item -> gọi reserve lặp là idempotent
flashSalePurchaseSchema.index({ order: 1, flashSaleItem: 1 }, { unique: true });
flashSalePurchaseSchema.index({ flashSaleItem: 1, user: 1, status: 1 });
flashSalePurchaseSchema.index({ order: 1, status: 1 });

const FlashSalePurchases = mongoose.model('FlashSalePurchases', flashSalePurchaseSchema);
export default FlashSalePurchases;