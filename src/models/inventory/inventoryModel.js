import mongoose from 'mongoose';

const inventorySchema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariants',
      required: true,
      unique: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Products',
      required: true,
      index: true,
    },

    quantity: { type: Number, default: 0, min: 0 },
    reservedQuantity: { type: Number, default: 0, min: 0 },

    reorderLevel: { type: Number, default: 0, min: 0 },
    reorderQuantity: { type: Number, default: 0, min: 0 },

    isActive: { type: Boolean, default: true },
    lastRestockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

inventorySchema.virtual('availableQuantity').get(function () {
  return Math.max(0, this.quantity - this.reservedQuantity);
});

inventorySchema.virtual('isLowStock').get(function () {
  return this.availableQuantity <= this.reorderLevel;
});

inventorySchema.set('toJSON', { virtuals: true });
inventorySchema.set('toObject', { virtuals: true });

inventorySchema.index({ quantity: 1 });
inventorySchema.index({ isActive: 1 });

const Inventory = mongoose.model('Inventory', inventorySchema);
export default Inventory;