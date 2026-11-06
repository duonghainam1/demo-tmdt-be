import mongoose from 'mongoose';

/**
 * Attribute - Thuộc tính sản phẩm
 *
 * type:
 *  - 'variant': dùng để SINH BIẾN THỂ (SKU). VD: Màu sắc, Dung lượng, RAM
 *  - 'spec'   : chỉ MÔ TẢ sản phẩm, không ảnh hưởng SKU/giá/tồn kho. VD: Chất liệu, Bảo hành, Xuất xứ
 *
 * inputType (chỉ có ý nghĩa với spec):
 *  - 'select': chọn 1 hoặc NHIỀU giá trị trong danh sách `values`
 *  - 'text'  : nhập tự do (VD "24 tháng"); `values` luôn rỗng
 *  Attribute 'variant' luôn là 'select'.
 *
 * isFilterable: có hiện ở bộ lọc trang danh mục hay không.
 *
 * Dữ liệu cũ chưa có `type` được coi là 'variant' (query dùng { type: { $ne: 'spec' } }).
 */
export const ATTRIBUTE_TYPES = ['variant', 'spec'];
export const ATTRIBUTE_INPUT_TYPES = ['select', 'text'];

const attributeValueSchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true }, // VD: "Đỏ", "XL"
    slug: { type: String, required: true, trim: true },
    // Có thể lưu thêm mã màu (hex) nếu attribute là màu sắc
    meta: { type: String, default: '' },
  },
  { _id: true }
);

const attributeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // VD: "Màu sắc"
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    type: { type: String, enum: ATTRIBUTE_TYPES, default: 'variant' },
    inputType: { type: String, enum: ATTRIBUTE_INPUT_TYPES, default: 'select' },
    isFilterable: { type: Boolean, default: true },
    values: [attributeValueSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

attributeSchema.index({ isActive: 1 });
attributeSchema.index({ type: 1, isActive: 1 });

const Attributes = mongoose.model('Attributes', attributeSchema);
export default Attributes;