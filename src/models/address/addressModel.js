import mongoose from 'mongoose';

/**
 * Address - Địa chỉ nhận hàng của người dùng.
 * Dùng mô hình hành chính 2 cấp (Tỉnh/Thành phố -> Phường/Xã), không có quận/huyện.
 * Lưu cả code lẫn name để hiển thị không cần gọi lại API hành chính,
 * và vẫn giữ lại được địa chỉ cũ nếu tên đơn vị hành chính thay đổi sau này.
 */
const addressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true, index: true },

    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: {
      type: String,
      required: true,
      trim: true,
      match: [/^(0|\+84)\d{9}$/, 'Số điện thoại không hợp lệ'],
    },

    provinceCode: { type: String, required: true, trim: true },
    provinceName: { type: String, required: true, trim: true },
    wardCode: { type: String, required: true, trim: true },
    wardName: { type: String, required: true, trim: true },
    detail: { type: String, required: true, trim: true, maxlength: 255 }, // Số nhà, tên đường...

    label: { type: String, enum: ['home', 'office', 'other'], default: 'home' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Danh sách địa chỉ của 1 user, mặc định lên đầu
addressSchema.index({ user: 1, isDefault: -1, createdAt: -1 });

// Đảm bảo ở tầng DB mỗi user chỉ có tối đa 1 địa chỉ mặc định
addressSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { isDefault: true }, name: 'one_default_per_user' }
);

const Addresses = mongoose.model('Addresses', addressSchema);
export default Addresses;