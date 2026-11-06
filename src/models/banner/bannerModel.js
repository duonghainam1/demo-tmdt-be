import mongoose from 'mongoose'

const { Schema } = mongoose

/* ---------- Hằng số ---------- */
export const BANNER_TYPES = ['top', 'main', 'small', 'category']

const bannerSchema = new Schema(
    {
        // Loại banner:
        // top      = thanh chạy trên cùng trang (chữ hoặc ảnh)
        // main     = banner chính, tự động đổi từ trái sang phải (chỉ ảnh)
        // small    = banner nhỏ dạng dài, nằm dưới khu menu (chỉ ảnh)
        // category = banner dài (690x100) đặt trên đầu khu sản phẩm của 1 danh mục (chỉ ảnh)
        type: {
            type: String,
            enum: { values: BANNER_TYPES, message: 'Loại banner không hợp lệ' },
            required: [true, 'Vui lòng chọn loại banner'],
        },

        // Danh mục mà banner thuộc về – chỉ dùng khi type = 'category'
        category: {
            type: Schema.Types.ObjectId,
            ref: 'Categorys',
            default: undefined,
        },

        // Kiểu nội dung: main/small/category luôn là 'image', chỉ banner top được chọn 'text'
        contentType: {
            type: String,
            enum: ['text', 'image'],
            default: 'image',
        },

        // Ảnh banner (lưu trên Cloudinary). Bắt buộc khi contentType = 'image'
        image: {
            url: { type: String, trim: true },
            publicId: { type: String, trim: true }, // dùng để xoá ảnh cũ khi sửa/xoá banner
        },

        // Nội dung chữ – chỉ dùng cho banner top khi contentType = 'text'
        text: { type: String, trim: true, maxlength: 200, default: '' },
        textColor: { type: String, trim: true, default: '#FFFFFF' },
        fontSize: {
            type: Number,
            default: 16,
            min: [10, 'Cỡ chữ tối thiểu 10px'],
            max: [40, 'Cỡ chữ tối đa 40px'],
        },
        backgroundColor: { type: String, trim: true, default: '#E53935' },
        // Chữ chạy ngang (marquee) hay đứng yên
        isMarquee: { type: Boolean, default: true },

        // Mô tả ảnh (alt) cho SEO/truy cập
        alt: { type: String, trim: true, maxlength: 120, default: '' },

        // Đường dẫn khi bấm vào banner: "/san-pham/..." hoặc "https://..."
        link: {
            type: String,
            trim: true,
            default: '',
            validate: {
                validator: (v) => !v || /^(\/|https?:\/\/)/i.test(v),
                message: 'Đường dẫn phải bắt đầu bằng / hoặc https://',
            },
        },

        // Thứ tự hiển thị trong cùng nhóm (nhỏ đứng trước)
        // Nhóm = cùng type; riêng type 'category' thì nhóm = cùng type + cùng danh mục
        order: { type: Number, default: 0, min: 0 },

        // Bật/tắt hiển thị trên trang chủ
        isActive: { type: Boolean, default: true },

        // Lên lịch hiển thị (để trống = không giới hạn)
        startAt: { type: Date, default: null },
        endAt: {
            type: Date,
            default: null,
            validate: {
                // Chạy khi create/save. Khoảng ngày khi cập nhật đã được controller kiểm tra
                validator: function (v) {
                    return !v || !this.startAt || v > this.startAt
                },
                message: 'Ngày kết thúc phải sau ngày bắt đầu',
            },
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
)

/* ---------- Validate theo loại banner ---------- */
// Mongoose 9 không còn truyền next vào pre hook: hàm đồng bộ tự kết thúc là đủ
bannerSchema.pre('validate', function () {
    // main, small, category: chỉ cho phép ảnh
    if (this.type !== 'top') {
        this.contentType = 'image'
    }

    // Banner theo danh mục bắt buộc có danh mục; loại khác thì bỏ field này
    if (this.type === 'category') {
        if (!this.category) {
            this.invalidate('category', 'Vui lòng chọn danh mục cho banner')
        }
    } else {
        this.category = undefined
    }

    if (this.contentType === 'image') {
        if (!this.image?.url || !this.image?.publicId) {
            this.invalidate('image', 'Vui lòng tải ảnh banner')
        }
        // Dọn các trường chữ không dùng đến
        this.text = ''
    } else {
        // contentType = 'text' (chỉ banner top)
        if (!this.text) {
            this.invalidate('text', 'Vui lòng nhập nội dung chữ cho banner top')
        }
        // Dọn ảnh không dùng đến (controller xoá ảnh cũ trên Cloudinary sau khi lưu)
        this.image = undefined
    }
})

/* ---------- Index ---------- */
// Truy vấn trang chủ: lọc theo loại (+ danh mục) + isActive rồi sắp theo order
bannerSchema.index({ type: 1, category: 1, isActive: 1, order: 1 })

/* ---------- Virtual: trạng thái hiển thị ---------- */
// 'active' | 'inactive' | 'scheduled' (sắp diễn ra) | 'expired' (hết hạn)
bannerSchema.virtual('status').get(function () {
    const now = new Date()
    if (!this.isActive) return 'inactive'
    if (this.startAt && this.startAt > now) return 'scheduled'
    if (this.endAt && this.endAt < now) return 'expired'
    return 'active'
})

/* ---------- Static: banner dành cho trang chủ ---------- */
// Dùng: Banner.findPublic('main') | Banner.findPublic('category', categoryId) | Banner.findPublic()
bannerSchema.statics.findPublic = function (type, category) {
    const now = new Date()
    const filter = {
        isActive: true,
        $and: [
            { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
            { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
        ],
    }
    if (type) filter.type = type
    if (category) filter.category = category
    return this.find(filter).sort({ order: 1, createdAt: -1 })
}

const Banner = mongoose.models.Banner || mongoose.model('Banner', bannerSchema)

export default Banner