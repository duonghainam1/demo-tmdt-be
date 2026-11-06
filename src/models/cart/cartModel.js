import mongoose from 'mongoose';

const MAX_QUANTITY = 99;
const MAX_ITEMS = 50;

const idOf = (v) => String(v?._id ?? v);

const cartItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Products',
      required: true,
    },
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariants',
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
      max: MAX_QUANTITY,
      validate: {
        validator: Number.isInteger,
        message: 'Số lượng phải là số nguyên',
      },
    },
    selected: { type: Boolean, default: true },
    priceWhenAdded: { type: Number, default: null, min: 0 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Users',
      required: true,
      unique: true,
    },

    items: {
      type: [cartItemSchema],
      default: [],
      validate: {
        validator: (arr) => arr.length <= MAX_ITEMS,
        message: `Giỏ hàng tối đa ${MAX_ITEMS} sản phẩm`,
      },
    },

    // Mã voucher đang áp dụng cho giỏ (chỉ lưu mã; số tiền giảm luôn được tính lại khi lấy giỏ)
    voucherCode: { type: String, default: null, trim: true },
  },
  { timestamps: true, versionKey: false }
);

cartSchema.index({ 'items.variant': 1 });

cartSchema.virtual('itemCount').get(function () {
  return this.items.length;
});

cartSchema.virtual('totalQuantity').get(function () {
  return this.items.reduce((sum, it) => sum + it.quantity, 0);
});

cartSchema.methods.findItem = function (variantId) {
  return this.items.find((it) => idOf(it.variant) === idOf(variantId));
};

cartSchema.methods.addItem = function ({ product, variant, quantity = 1, priceWhenAdded = null }) {
  const existing = this.findItem(variant);

  if (existing) {
    existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + quantity);
    if (priceWhenAdded != null) existing.priceWhenAdded = priceWhenAdded;
    return existing;
  }

  this.items.push({
    product,
    variant,
    quantity: Math.min(MAX_QUANTITY, quantity),
    priceWhenAdded,
  });
  return this.items[this.items.length - 1];
};

cartSchema.methods.updateItem = function (itemId, { quantity, selected } = {}) {
  const item = this.items.id(itemId);
  if (!item) return null;

  if (quantity !== undefined) item.quantity = Math.min(MAX_QUANTITY, Math.max(1, quantity));
  if (selected !== undefined) item.selected = Boolean(selected);
  return item;
};

cartSchema.methods.removeItem = function (itemId) {
  const item = this.items.id(itemId);
  if (!item) return false;
  item.deleteOne();
  if (this.items.length === 0) this.voucherCode = null;
  return true;
};

cartSchema.methods.setAllSelected = function (selected) {
  this.items.forEach((it) => {
    it.selected = Boolean(selected);
  });
};

cartSchema.methods.clear = function () {
  this.items = [];
  this.voucherCode = null;
};

// Dùng sau khi đặt hàng: xoá các dòng đã mua và bỏ voucher đã dùng
cartSchema.methods.removeSelected = function () {
  this.items = this.items.filter((it) => !it.selected);
  this.voucherCode = null;
};

cartSchema.methods.clearVoucher = function () {
  this.voucherCode = null;
};

cartSchema.statics.findOrCreateByUser = async function (userId) {
  return this.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId, items: [] } },
    { new: true, upsert: true }
  );
};

cartSchema.set('toJSON', { virtuals: true });
cartSchema.set('toObject', { virtuals: true });

export default mongoose.model('Carts', cartSchema);