import Voucher from "../../models/voucher/voucherModel.js";
import UserVoucher from "../../models/voucher/userVoucherModel.js";
import VoucherUsage from "../../models/voucher/voucherUsageModel.js";
import Order from "../../models/orders/ordersModel.js";

export const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * cart = { items: [{ product, category, price, quantity }], shippingFee }
 * QUAN TRỌNG: items phải được dựng từ DB (giá lấy từ Product), KHÔNG tin giá client gửi lên.
 */
export const calcDiscount = (voucher, cart) => {
    const { items, shippingFee = 0 } = cart;

    let eligible = items;
    if (voucher.type !== "free_shipping") {
        if (voucher.applyTo === "products") {
            const ids = voucher.applicableProducts.map(String);
            eligible = items.filter((i) => ids.includes(String(i.product)));
        } else if (voucher.applyTo === "categories") {
            const ids = voucher.applicableCategories.map(String);
            eligible = items.filter((i) => ids.includes(String(i.category)));
        }
    }

    const eligibleTotal = eligible.reduce((s, i) => s + i.price * i.quantity, 0);
    if (eligibleTotal <= 0) throw httpError(400, "Giỏ hàng không có sản phẩm áp dụng được voucher này");
    if (eligibleTotal < voucher.minOrderValue) {
        throw httpError(400, `Đơn hàng cần tối thiểu ${voucher.minOrderValue.toLocaleString("vi-VN")}đ để dùng voucher`);
    }

    let discount = 0;
    if (voucher.type === "percentage") {
        discount = Math.floor((eligibleTotal * voucher.value) / 100);
        if (voucher.maxDiscount) discount = Math.min(discount, voucher.maxDiscount);
    } else if (voucher.type === "fixed_amount") {
        discount = Math.min(voucher.value, eligibleTotal);
    } else {
        // free_shipping: value = 0 -> miễn phí hoàn toàn
        discount = voucher.value > 0 ? Math.min(voucher.value, shippingFee) : shippingFee;
    }
    return { discountAmount: discount, eligibleTotal };
};

/**
 * Kiểm tra voucher dùng được không + tính tiền giảm (KHÔNG ghi DB).
 * `session` (tuỳ chọn): truyền khi gọi trong transaction để đọc đúng snapshot.
 */
export const validateVoucher = async (code, userId, cart, session = null) => {
    const voucher = await Voucher.findOne({ code: String(code).trim().toUpperCase() }).session(session);
    if (!voucher || voucher.status !== "active") throw httpError(404, "Voucher không tồn tại hoặc không khả dụng");

    const now = new Date();
    if (voucher.startDate > now) throw httpError(400, "Voucher chưa đến thời gian áp dụng");
    if (voucher.isExpired) throw httpError(400, "Voucher đã hết hạn");
    if (voucher.isOutOfUsage) throw httpError(400, "Voucher đã hết lượt sử dụng");

    if (voucher.audience === "new_user") {
        const orderCount = await Order.countDocuments({ user: userId, status: { $ne: "cancelled" } }).session(session);
        if (orderCount > 0) throw httpError(400, "Voucher chỉ dành cho khách hàng mới");
    }

    // claimable / assigned: phải có trong ví
    if (voucher.distribution !== "public_code") {
        const inWallet = await UserVoucher.exists({ user: userId, voucher: voucher._id }).session(session);
        if (!inWallet) throw httpError(403, "Bạn chưa nhận voucher này");
    }

    const usedByUser = await VoucherUsage.countDocuments({
        voucher: voucher._id,
        user: userId,
        status: { $in: ["reserved", "used"] },
    }).session(session);
    if (usedByUser >= voucher.usageLimitPerUser) throw httpError(400, "Bạn đã dùng hết lượt của voucher này");

    const { discountAmount } = calcDiscount(voucher, cart);
    return { voucher, discountAmount };
};

/**
 * Gọi khi TẠO ĐƠN, BÊN TRONG transaction: giữ chỗ voucher.
 *
 * Chống 2 request song song: mọi đơn dùng cùng 1 voucher đều phải $inc cùng 1 document Voucher,
 * nên MongoDB báo WriteConflict cho transaction đến sau, withTransaction tự chạy lại và lần chạy
 * lại validateVoucher sẽ thấy lượt của đơn đầu -> không vượt usageLimit / usageLimitPerUser.
 * Lỗi ở bước nào thì transaction huỷ hết, không cần tự rollback.
 */
export const reserveVoucher = async (code, userId, orderId, cart, session) => {
    const { voucher, discountAmount } = await validateVoucher(code, userId, cart, session);

    // tăng nguyên tử, null = vừa bị người khác giành lượt cuối
    const updated = await Voucher.increaseUsedCount(voucher._id, session);
    if (!updated) throw httpError(400, "Voucher đã hết lượt sử dụng");

    const [usage] = await VoucherUsage.create(
        [{ voucher: voucher._id, user: userId, order: orderId, discountAmount, status: "reserved" }],
        { session }
    );

    // public_code có thể không có trong ví -> updateOne không khớp bản ghi nào, không sao
    await UserVoucher.updateOne({ user: userId, voucher: voucher._id }, { $inc: { usedCount: 1 } }, { session });

    return { voucher, discountAmount, usage };
};

/** Đơn hoàn tất: reserved -> used. Gọi trong transaction. */
export const markVoucherUsed = (orderId, session = null) =>
    VoucherUsage.updateOne({ order: orderId, status: "reserved" }, { status: "used" }, { session });

/**
 * Đơn huỷ / trả hàng: hoàn lượt. Gọi trong transaction.
 * Điều kiện status chống hoàn 2 lần; đơn không dùng voucher thì không làm gì.
 */
export const refundVoucher = async (orderId, session = null) => {
    const usage = await VoucherUsage.findOneAndUpdate(
        { order: orderId, status: { $in: ["reserved", "used"] } },
        { status: "refunded" },
        { session }
    );
    if (!usage) return;
    await Voucher.updateOne({ _id: usage.voucher, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
    await UserVoucher.updateOne(
        { user: usage.user, voucher: usage.voucher, usedCount: { $gt: 0 } },
        { $inc: { usedCount: -1 } },
        { session }
    );
};

/** Khách bấm "Nhận ngay" */
export const claimVoucher = async (voucherId, userId) => {
    const voucher = await Voucher.findOne({ _id: voucherId, ...Voucher.activeFilter() });
    if (!voucher || voucher.distribution !== "claimable") throw httpError(404, "Voucher không thể nhận");

    // tạo trước: unique index chặn nhận 2 lần
    try {
        await UserVoucher.create({ user: userId, voucher: voucher._id, source: "claimed" });
    } catch (err) {
        if (err.code === 11000) throw httpError(409, "Bạn đã nhận voucher này rồi");
        throw err;
    }

    let updated;
    try {
        updated = await Voucher.increaseClaimedCount(voucher._id);
    } catch (err) {
        // lỗi bất ngờ: gỡ bản ghi ví vừa tạo rồi ném lỗi tiếp
        await UserVoucher.deleteOne({ user: userId, voucher: voucher._id });
        throw err;
    }

    if (!updated) {
        await UserVoucher.deleteOne({ user: userId, voucher: voucher._id });
        throw httpError(400, "Voucher đã hết lượt nhận");
    }
    return updated;
};