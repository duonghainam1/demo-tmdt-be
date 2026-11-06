import mongoose from 'mongoose';
import { createPricingSchema } from './pricingModel.js';
import { buildSearchKey } from '../../utils/searchKey.js';

// Thông số kỹ thuật (thuộc tính KHÔNG sinh biến thể). Lưu snapshot để hiển thị/lọc nhanh.
// - attribute  : Attribute loại 'spec'
// - valueId    : _id của value (inputType 'select'); null nếu nhập tay
//                Thuộc tính 'select' chọn NHIỀU giá trị -> nhiều dòng cùng `attribute`, mỗi dòng 1 valueId
// - value      : giá trị hiển thị
// - valueSlug  : slug của value, dùng để lọc (?<attributeSlug>=<valueSlug>)
const specSchema = new mongoose.Schema(
  {
    attribute: { type: mongoose.Schema.Types.ObjectId, ref: 'Attributes', required: true },
    attributeName: { type: String, required: true, trim: true },
    valueId: { type: mongoose.Schema.Types.ObjectId, default: null },
    value: { type: String, required: true, trim: true },
    valueSlug: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    shortDescription: { type: String, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Categorys', required: true },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brands', default: null },

    images: [
      {
        url: { type: String, default: '' },
        publicId: { type: String, default: '' },
      },
    ],

    // Mỗi sản phẩm tối đa 1 video (link YouTube). Rỗng = không có video
    video: {
      youtubeUrl: { type: String, default: '' },
      videoId: { type: String, default: '' },
    },

    // Thuộc tính SINH BIẾN THỂ
    variantAttributes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attributes' }],
    hasVariants: { type: Boolean, default: false },

    // Thuộc tính KHÔNG sinh biến thể (thông số kỹ thuật)
    specs: { type: [specSchema], default: [] },

    // Sản phẩm đi kèm / phụ kiện (chỉ lưu ID, thứ tự mảng = thứ tự hiển thị)
    accessories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Products' }],

    // MỚI: Số tháng bảo hành (0 = không bảo hành). Thời gian bắt đầu tính từ lúc giao hàng thành công.
    warrantyMonths: { type: Number, default: 0, min: 0, max: 120 },

    pricing: { type: createPricingSchema({ required: true }), required: true },
    priceMin: { type: Number, default: 0, min: 0 },
    priceMax: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ['draft', 'active', 'inactive'],
      default: 'draft',
    },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },

    tags: [{ type: String }],
    searchKey: { type: String, default: '' },

    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0 },
    soldCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ status: 1 });
productSchema.index({ status: 1, priceMin: 1 });
productSchema.index({ deletedAt: 1 });
productSchema.index({ tags: 1 }); // lọc theo tag nhanh
productSchema.index({ 'specs.attribute': 1, 'specs.valueSlug': 1 }); // lọc theo thông số
productSchema.index({ 'specs.valueId': 1 }); // kiểm tra value đang được dùng
productSchema.index({ accessories: 1 }); // tìm sản phẩm đang dùng món này làm đi kèm

// Chuẩn hóa tags + sinh lại searchKey khi tạo mới hoặc khi đổi tên / thương hiệu / danh mục / tags
productSchema.pre('save', async function () {
  // 1. Chuẩn hóa tag để "Gaming" và "gaming" không bị tách đôi
  if (this.isNew || this.isModified('tags')) {
    this.tags = [
      ...new Set((this.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)),
    ];
  }

  // 2. Sinh lại searchKey (chạy sau bước 1 nên dùng tag đã chuẩn hóa)
  if (
    this.isNew ||
    this.isModified('name') ||
    this.isModified('brand') ||
    this.isModified('category') ||
    this.isModified('tags')
  ) {
    this.searchKey = await buildSearchKey(this);
  }
});

productSchema.methods.getPriceInfo = function (now = new Date()) {
  return this.pricing.getPriceInfo(now);
};

const Products = mongoose.model('Products', productSchema);
export default Products;