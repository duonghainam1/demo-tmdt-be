import mongoose from "mongoose";

// Ví voucher: voucher khách đã nhận hoặc được tặng ("Voucher của tôi")
const userVoucherSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
        voucher: { type: mongoose.Schema.Types.ObjectId, ref: "Voucher", required: true },
        source: {
            type: String,
            enum: ["claimed", "assigned"], // tự nhận / được tặng
            default: "claimed",
        },
        usedCount: { type: Number, min: 0, default: 0 }, // số lần khách này đã dùng
        claimedAt: { type: Date, default: Date.now },
    },
    { timestamps: true, versionKey: false }
);

// Mỗi khách chỉ nhận 1 lần mỗi voucher (chặn bấm "Nhận ngay" nhiều lần)
userVoucherSchema.index({ user: 1, voucher: 1 }, { unique: true });
userVoucherSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("UserVoucher", userVoucherSchema);