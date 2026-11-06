import mongoose from 'mongoose';

/**
 * Mỗi dòng đơn hàng là ẢNH CHỤP (snapshot) tại thời điểm đặt: tên, ảnh, giá...
 * Sau này sản phẩm đổi tên / đổi giá thì đơn cũ vẫn giữ nguyên.
 */
const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Products', required: true },
  variant: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariants', required: true },
  sku: { type: String, default: '' },
  name: { type: String, required: true },
  image: { type: String, default: '' },
  attributes: [
    {
      _id: false,
      name: { type: String, required: true },
      value: { type: String, required: true },
    },
  ],
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 }, // giá bán hiệu lực lúc đặt
  originalPrice: { type: Number, default: 0, min: 0 }, // giá niêm yết lúc đặt
  lineTotal: { type: Number, required: true, min: 0 },
  // Truy vết dòng nào mua theo giá giờ vàng (null nếu mua giá thường)
  flashSaleItem: { type: mongoose.Schema.Types.ObjectId, default: null },
  // [TRẢ HÀNG] Số lượng đã được khách trả (đã hoàn tất). Đơn cũ chưa có trường này, code đọc qua (returnedQuantity || 0)
  returnedQuantity: { type: Number, default: 0, min: 0 },
  // [BẢO HÀNH] Số tháng bảo hành chốt lúc đặt hàng (0 = không bảo hành). KHÔNG đặt default để đơn cũ
  // vẫn là undefined: code tra cứu bảo hành đọc qua (it.warrantyMonths ?? số tháng hiện tại của sản phẩm).
  warrantyMonths: { type: Number, min: 0, max: 120 },
});

const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    province: { type: String, required: true, trim: true },
    ward: { type: String, required: true, trim: true },
    addressLine: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    note: { type: String, default: '' },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
  },
  { _id: false }
);

/**
 * Yêu cầu hủy đơn của khách khi không còn tự hủy được
 * (đơn đã xác nhận, hoặc đã quá 15 phút kể từ lúc đặt). Admin duyệt thì đơn mới bị hủy.
 *   none -> pending -> approved | rejected   (mỗi đơn chỉ gửi 1 lần)
 */
const cancelRequestSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    reason: { type: String, default: '', trim: true, maxlength: 300 }, // lý do của khách
    requestedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
    adminNote: { type: String, default: '', trim: true, maxlength: 300 }, // lý do từ chối / ghi chú của admin
  },
  { _id: false }
);

/**
 * [TRẢ HÀNG] Yêu cầu trả hàng của khách (chỉ với đơn đã completed, trong thời hạn đổi trả).
 *   none -> pending -> approved -> completed
 *                   -> rejected
 * Mỗi đơn chỉ gửi 1 lần (có thể trả một phần hoặc toàn bộ).
 * Đơn vẫn giữ status "completed", trạng thái trả hàng nằm hoàn toàn ở đây.
 */
const returnRequestSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected', 'completed'],
      default: 'none',
    },
    reason: { type: String, default: '', trim: true, maxlength: 300 }, // lý do của khách
    items: [
      {
        _id: false,
        orderItem: { type: mongoose.Schema.Types.ObjectId, required: true }, // _id của dòng trong order.items
        quantity: { type: Number, required: true, min: 1 },
        restock: { type: Boolean, default: null }, // admin quyết định lúc nhận hàng (true = nhập lại kho, false = hàng lỗi)
      },
    ],
    refundAmount: { type: Number, default: 0, min: 0 },
    requestedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null }, // lúc duyệt / từ chối
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
    completedAt: { type: Date, default: null }, // lúc nhận hàng + hoàn tiền
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
    adminNote: { type: String, default: '', trim: true, maxlength: 300 }, // lý do từ chối / ghi chú của admin
  },
  { _id: false }
);

/**
 * Thông tin vận chuyển, admin nhập khi chuyển confirmed -> shipping.
 * Đơn cũ chưa có trường này, code luôn đọc qua shipping?.carrier
 */
export const CARRIERS = ['jnt', 'viettel_post', 'ghtk', 'ghn'];

const shippingInfoSchema = new mongoose.Schema(
  {
    carrier: { type: String, enum: [...CARRIERS, null], default: null },
    trackingCode: { type: String, default: '', trim: true, uppercase: true, maxlength: 30 },
    shippedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Luồng trạng thái đơn:
 *   pending -> confirmed -> shipping -> completed                (giao thành công)
 *                                    -> returning -> returned    (giao thất bại / khách bom hàng)
 *   pending | confirmed -> cancelled
 */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'shipping',
  'completed',
  'returning', // Hoàn hàng: giao thất bại / bom hàng, chờ đơn vị vận chuyển trả hàng về
  'returned', // Đã trả hàng hoàn về kho
  'cancelled',
];
export const PAYMENT_METHODS = ['cod', 'bank_transfer'];
// [TRẢ HÀNG] thêm partially_refunded
export const PAYMENT_STATUSES = ['unpaid', 'paid', 'partially_refunded', 'refunded'];

const orderSchema = new mongoose.Schema(
  {
    // Mã đơn hiển thị cho khách, vd NX260929AB12CD
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true, index: true },

    items: {
      type: [orderItemSchema],
      validate: { validator: (arr) => arr.length > 0, message: 'Đơn hàng phải có ít nhất 1 sản phẩm' },
    },

    shippingAddress: { type: shippingAddressSchema, required: true },
    note: { type: String, default: '', trim: true, maxlength: 500 },

    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },

    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },

    subtotal: { type: Number, required: true, min: 0 },
    shippingFee: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    voucherCode: { type: String, default: null },
    voucher: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'VND', uppercase: true },

    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Đơn cũ chưa có trường này, code luôn đọc qua cancelRequest?.status
    cancelRequest: { type: cancelRequestSchema, default: () => ({}) },

    // [TRẢ HÀNG] Tổng tiền đã hoàn cho khách (cộng dồn)
    refundedAmount: { type: Number, default: 0, min: 0 },

    // [TRẢ HÀNG] Đơn cũ chưa có trường này, code luôn đọc qua returnRequest?.status
    returnRequest: { type: returnRequestSchema, default: () => ({}) },

    // Đơn vị vận chuyển + mã vận đơn (điền khi chuyển sang "shipping")
    shipping: { type: shippingInfoSchema, default: () => ({}) },
  },
  { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ 'cancelRequest.status': 1, createdAt: -1 });
orderSchema.index({ 'returnRequest.status': 1, createdAt: -1 }); // [TRẢ HÀNG]
// [BẢO HÀNH] tra cứu theo SĐT người nhận + đơn đã hoàn tất
orderSchema.index({ 'shippingAddress.phone': 1, status: 1 });

const Orders = mongoose.model('Orders', orderSchema);
export default Orders;