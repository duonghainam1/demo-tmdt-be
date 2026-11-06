import mongoose from 'mongoose';

const inventoryTransactionSchema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariants',
      required: true,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Products',
      required: true,
      index: true,
    },
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: [
        'import', // Nhập kho
        'export', // Xuất kho (gồm xuất linh kiện cho đơn sửa chữa)
        'adjust', // Điều chỉnh tồn kho (kiểm kê)

        'order_reserve', // Giữ hàng cho đơn
        'order_release', // Hủy giữ hàng
        'order_complete', // Đơn hoàn tất, trừ tồn thật

        'return', // Khách trả hàng
      ],
      required: true,
      index: true,
    },

    /**
     * quantity: giá trị CÓ DẤU của mức thay đổi.
     * Dương (+) = tăng tồn; Âm (-) = giảm tồn.
     * Luôn đảm bảo: afterQuantity = beforeQuantity + quantity
     */
    quantity: { type: Number, required: true },

    beforeQuantity: { type: Number, required: true, min: 0 },
    afterQuantity: { type: Number, required: true, min: 0 },
    beforeReservedQuantity: { type: Number, required: true, min: 0, default: 0 },
    afterReservedQuantity: { type: Number, required: true, min: 0, default: 0 },

    note: { type: String, default: '', trim: true },

    refOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Orders',
      default: null,
      index: true,
    },

    // Đơn sửa chữa đã xuất linh kiện (đổi ref cho đúng tên model đơn sửa chữa của bạn)
    refRepair: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RepairRequest',
      default: null,
      index: true,
    },

    // TODO: gán ref: 'StockImports' khi có model StockImport
    refImport: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Users',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

inventoryTransactionSchema.index({ variant: 1, createdAt: -1 });
inventoryTransactionSchema.index({ inventory: 1, createdAt: -1 });
inventoryTransactionSchema.index({ type: 1, createdAt: -1 });
inventoryTransactionSchema.index({ product: 1, createdAt: -1 });

// TODO: bật lại validate `beforeQuantity + quantity === afterQuantity`
// (Mongoose 9: dùng function() không có `next`, và `throw new Error(...)` khi sai)

const InventoryTransactions = mongoose.model(
  'InventoryTransactions',
  inventoryTransactionSchema
);

export default InventoryTransactions;