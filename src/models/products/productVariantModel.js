import mongoose from 'mongoose';
import { createPricingSchema } from './pricingModel.js';

const variantAttributeSchema = new mongoose.Schema(
  {
    attribute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Attributes',
      required: true,
    },
    attributeName: { type: String, required: true, trim: true },
    valueId: { type: mongoose.Schema.Types.ObjectId, required: true },
    value: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const productVariantSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Products',
      required: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    attributes: { type: [variantAttributeSchema], default: [] },
    attributeKey: { type: String, required: true },

    image: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },

    weight: { type: Number, default: 0, min: 0 },
    barcode: { type: String, default: '', trim: true },
    pricing: { type: createPricingSchema({ required: false }), default: undefined },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productVariantSchema.index({ product: 1 });
productVariantSchema.index({ isActive: 1 });
productVariantSchema.index({ product: 1, attributeKey: 1 }, { unique: true });
productVariantSchema.methods.getPriceInfo = function (product, now = new Date()) {
  const hasOwnPrice = this.pricing && this.pricing.price != null;
  const source = hasOwnPrice ? this.pricing : product.pricing;
  return { ...source.getPriceInfo(now), inheritedFromProduct: !hasOwnPrice };
};

const ProductVariants = mongoose.model('ProductVariants', productVariantSchema);
export default ProductVariants;