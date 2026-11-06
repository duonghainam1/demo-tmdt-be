import mongoose from "mongoose";

// Lịch sử dùng voucher theo đơn hàng: để đối soát, hoàn voucher, báo cáo
const voucherUsageSchema = new mongoose.Schema(
    {
        voucher: { type: mongoose.Schema.Types.ObjectId, ref: "Voucher", required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
        order: { type: mongoose.Schema.Types.ObjectId, ref: "Orders", required: true },
        discountAmount: { type: Number, min: 0, required: true },
        status: {
            type: String,
            enum: ["reserved", "used", "refunded"],
            default: "reserved",
            // reserved: giữ chỗ khi đặt đơn
            // used:     đơn thanh toán/hoàn tất
            // refunded: đơn hủy/trả hàng, hoàn lại lượt dùng
        },
    },
    { timestamps: true, versionKey: false }
);

voucherUsageSchema.index({ voucher: 1, user: 1 });
voucherUsageSchema.index({ order: 1 });

export default mongoose.model("VoucherUsage", voucherUsageSchema);