import mongoose from "mongoose";

// 20000 -> "20K", 199000 -> "199K", 1500 -> "1.500"
const formatMoney = (v) =>
    v >= 1000 && v % 1000 === 0 ? `${v / 1000}K` : v.toLocaleString("vi-VN");

const voucherSchema = new mongoose.Schema(
    {
        // ---------- Nhận diện ----------
        code: {
            type: String,
            required: [true, "Mã voucher là bắt buộc"],
            unique: true,
            uppercase: true,
            trim: true,
            match: [/^[A-Z0-9_-]{3,30}$/, "Mã chỉ gồm chữ, số, - hoặc _ (3-30 ký tự)"],
        },
        name: { type: String, required: true, trim: true },
        description: { type: String, trim: true },

        // ---------- Loại & giá trị ----------
        type: {
            type: String,
            enum: ["percentage", "fixed_amount", "free_shipping"],
            required: true,
        },
        // percentage: 1-100 | fixed_amount: số tiền | free_shipping: mức giảm ship tối đa (0 = miễn phí hoàn toàn)
        value: { type: Number, min: 0, default: 0 },
        maxDiscount: { type: Number, min: 0, default: null }, // trần giảm, dùng cho loại %

        // ---------- Điều kiện áp dụng ----------
        minOrderValue: { type: Number, min: 0, default: 0 },
        applyTo: {
            type: String,
            enum: ["all", "products", "categories"],
            default: "all",
        },
        applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Products" }],
        applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Categorys" }],

        // ---------- Đối tượng khách hàng ----------
        // Voucher tặng riêng cho từng người dùng distribution = "assigned" + UserVoucher
        audience: {
            type: String,
            enum: ["all", "new_user"],
            default: "all",
        },

        // ---------- Cách phân phối ----------
        distribution: {
            type: String,
            enum: ["public_code", "claimable", "assigned"],
            default: "public_code",
            // public_code: nút "Sao chép", nhập mã ở giỏ hàng là dùng
            // claimable:   nút "Nhận ngay", phải nhận vào ví mới dùng được
            // assigned:    hệ thống/admin tặng thẳng vào ví
        },
        isPublic: { type: Boolean, default: true }, // hiện ở khu "Voucher dành cho bạn"
        displayOrder: { type: Number, default: 0 },

        // ---------- Thời gian ----------
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },

        // ---------- Giới hạn ----------
        usageLimit: { type: Number, min: 0, default: null }, // tổng lượt dùng, null = không giới hạn
        usedCount: { type: Number, min: 0, default: 0 },
        usageLimitPerUser: { type: Number, min: 1, default: 1 },
        claimLimit: { type: Number, min: 0, default: null }, // tổng lượt nhận (claimable), null = không giới hạn
        claimedCount: { type: Number, min: 0, default: 0 },

        // ---------- Kết hợp & trạng thái ----------
        isStackable: { type: Boolean, default: false },
        status: {
            type: String,
            enum: ["draft", "active", "paused"],
            default: "draft",
        },
        // "Hết hạn" / "Hết lượt" không lưu cứng, tính từ endDate, usedCount

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
    },
    { timestamps: true, versionKey: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// ---------- Validate liên trường ----------
voucherSchema.pre("validate", function () {
    if (this.startDate && this.endDate && this.endDate <= this.startDate) {
        this.invalidate("endDate", "Ngày kết thúc phải sau ngày bắt đầu");
    }

    if (this.type === "percentage") {
        if (!(this.value > 0 && this.value <= 100)) {
            this.invalidate("value", "Giảm theo % phải trong khoảng 1-100");
        }
    } else if (this.type === "fixed_amount") {
        if (!(this.value > 0)) {
            this.invalidate("value", "Số tiền giảm phải lớn hơn 0");
        }
    }

    if (this.applyTo === "products" && !this.applicableProducts?.length) {
        this.invalidate("applicableProducts", "Cần chọn ít nhất 1 sản phẩm");
    }
    if (this.applyTo === "categories" && !this.applicableCategories?.length) {
        this.invalidate("applicableCategories", "Cần chọn ít nhất 1 danh mục");
    }

    if (this.usageLimit !== null && this.usedCount > this.usageLimit) {
        this.invalidate("usedCount", "Số lượt đã dùng vượt quá giới hạn");
    }
    if (this.claimLimit !== null && this.claimedCount > this.claimLimit) {
        this.invalidate("claimedCount", "Số lượt đã nhận vượt quá giới hạn");
    }
});

// ---------- Virtuals: dùng cho UI ----------
// "GIẢM 20K" / "GIẢM 10%" / "FREESHIP"
voucherSchema.virtual("displayTitle").get(function () {
    if (this.type === "percentage") return `GIẢM ${this.value}%`;
    if (this.type === "fixed_amount") return `GIẢM ${formatMoney(this.value)}`;
    return "FREESHIP";
});

// "Đơn từ 199K"
voucherSchema.virtual("displayCondition").get(function () {
    return this.minOrderValue > 0 ? `Đơn từ ${formatMoney(this.minOrderValue)}` : "Mọi đơn hàng";
});

voucherSchema.virtual("isExpired").get(function () {
    return this.endDate < new Date();
});

voucherSchema.virtual("isOutOfUsage").get(function () {
    return this.usageLimit !== null && this.usedCount >= this.usageLimit;
});

voucherSchema.virtual("isOutOfClaim").get(function () {
    return this.claimLimit !== null && this.claimedCount >= this.claimLimit;
});

// ---------- Statics ----------
// Điều kiện lọc voucher đang hiệu lực (còn hạn, đang active, còn lượt)
voucherSchema.statics.activeFilter = function (now = new Date()) {
    return {
        status: "active",
        startDate: { $lte: now },
        endDate: { $gte: now },
        $and: [
            { $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
        ],
    };
};

// Tăng usedCount nguyên tử khi đặt đơn, tránh 2 người giành lượt cuối. Trả về null nếu hết lượt dùng.
voucherSchema.statics.increaseUsedCount = function (voucherId, session = null) {
    return this.findOneAndUpdate(
        {
            _id: voucherId,
            $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
        },
        { $inc: { usedCount: 1 } },
        { new: true, session }
    );
};

// Tăng claimedCount nguyên tử khi khách bấm "Nhận ngay". Trả về null nếu hết lượt nhận.
voucherSchema.statics.increaseClaimedCount = function (voucherId, session = null) {
    return this.findOneAndUpdate(
        {
            _id: voucherId,
            $or: [{ claimLimit: null }, { $expr: { $lt: ["$claimedCount", "$claimLimit"] } }],
        },
        { $inc: { claimedCount: 1 } },
        { new: true, session }
    );
};

// ---------- Index ----------
voucherSchema.index({ status: 1, startDate: 1, endDate: 1 });
voucherSchema.index({ isPublic: 1, displayOrder: 1 });
// Phục vụ API danh sách voucher công khai (có phân trang)
voucherSchema.index({ status: 1, isPublic: 1, distribution: 1, displayOrder: 1, createdAt: -1 });

export default mongoose.model("Voucher", voucherSchema);