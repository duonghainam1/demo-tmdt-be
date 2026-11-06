
import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema(
  {
    // Tên vai trò: Quản trị viên, Nhân viên, Khách hàng...
    name: {
      type: String,
      required: [true, 'Tên vai trò là bắt buộc'],
      trim: true,
      unique: true,
    },

    // Mã vai trò dùng trong code
    code: {
      type: String,
      required: [true, 'Mã vai trò là bắt buộc'],
      unique: true,
      uppercase: true,
      trim: true,
      immutable: true,
    },

    // Mô tả vai trò
    description: {
      type: String,
      trim: true,
      default: '',
    },

    // Danh sách quyền được cấp
    permissions: [
      {
        type: String,
        trim: true,
      },
    ],

    // Trạng thái hoạt động
    isActive: {
      type: Boolean,
      default: true,
    },

    // Vai trò hệ thống, không cho phép xóa tùy tiện
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export default mongoose.model('Role', roleSchema);
