import mongoose from 'mongoose';

const priceHistorySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, default: 0, min: 0 },
    costPrice: { type: Number, default: 0, min: 0 },
    salePrice: { type: Number, default: null, min: 0 },
    note: { type: String, default: '', trim: true },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);
export const createPricingSchema = ({ required = false } = {}) => {
  const schema = new mongoose.Schema(
    {
      price: { type: Number, required, min: 0, default: required ? undefined : null },
      compareAtPrice: { type: Number, default: 0, min: 0 },
      costPrice: { type: Number, default: 0, min: 0 },
      salePrice: { type: Number, default: null, min: 0 },
      currency: { type: String, default: 'VND', uppercase: true, trim: true },

      saleStartDate: { type: Date, default: null },
      saleEndDate: { type: Date, default: null },

      history: { type: [priceHistorySchema], default: [] },
    },
    { _id: false }
  );

  schema.methods.isSaleActive = function (now = new Date()) {
    if (this.salePrice == null) return false;
    if (!this.saleStartDate || !this.saleEndDate) return false;
    return now >= this.saleStartDate && now <= this.saleEndDate;
  };

  schema.methods.getEffectivePrice = function (now = new Date()) {
    return this.isSaleActive(now) ? this.salePrice : this.price;
  };

  schema.methods.getPriceInfo = function (now = new Date()) {
    const saleActive = this.isSaleActive(now);
    return {
      price: this.price,
      compareAtPrice: this.compareAtPrice,
      salePrice: this.salePrice,
      effectivePrice: saleActive ? this.salePrice : this.price,
      isSaleActive: saleActive,
      currency: this.currency,
      saleStartDate: this.saleStartDate,
      saleEndDate: this.saleEndDate,
    };
  };

  return schema;
};