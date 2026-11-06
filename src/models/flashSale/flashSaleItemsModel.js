import mongoose from 'mongoose';
const flashSaleItemSchema = new mongoose.Schema(
  {
    flashSale: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashSales', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Products', required: true },
    variant: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariants', required: true },

    flashPrice: { type: Number, required: true, min: 0 },
    quota: { type: Number, required: true, min: 0 },
    sold: { type: Number, default: 0, min: 0 },
    limitPerUser: { type: Number, default: 0, min: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

flashSaleItemSchema.index({ flashSale: 1, variant: 1 }, { unique: true });
flashSaleItemSchema.index({ flashSale: 1, isActive: 1 });
flashSaleItemSchema.index({ variant: 1 });

const FlashSaleItems = mongoose.model('FlashSaleItems', flashSaleItemSchema);
export default FlashSaleItems;