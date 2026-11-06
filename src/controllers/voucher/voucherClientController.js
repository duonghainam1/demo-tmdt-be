import Voucher from "../../models/voucher/voucherModel.js";
import UserVoucher from "../../models/voucher/userVoucherModel.js";
import VoucherUsage from "../../models/voucher/voucherUsageModel.js";
import Product from "../../models/products/productModel.js";
import { httpError, validateVoucher, claimVoucher } from "../../services/voucher/voucherService.js";

// Dựng giỏ hàng từ DB: giá lấy từ Product, không tin client
export const buildCart = async (rawItems = [], shippingFee = 0) => {
    const products = await Product.find({ _id: { $in: rawItems.map((i) => i.productId) } }).select("price category");
    const map = new Map(products.map((p) => [String(p._id), p]));
    const items = rawItems.map((i) => {
        const p = map.get(String(i.productId));
        if (!p) throw httpError(400, "Sản phẩm không tồn tại");
        return { product: p._id, category: p.category, price: p.price, quantity: i.quantity };
    });
    return { items, shippingFee };
};

// GET /vouchers   (auth tùy chọn) -> khu "Voucher dành cho bạn"
export const listPublic = async (req, res) => {
    // 1. Chuẩn hóa tham số phân trang
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    // 2. Voucher user đã nhận (chỉ khi đã đăng nhập)
    let claimedIds = [];
    if (req.user) {
        const wallet = await UserVoucher.find({ user: req.user._id }).select("voucher").lean();
        claimedIds = wallet.map((w) => w.voucher);
    }
    const claimed = new Set(claimedIds.map(String));

    // 3. Filter: dùng $and để không đè lên $and/$or bên trong activeFilter()
    const filter = {
        $and: [
            Voucher.activeFilter(),
            { isPublic: true, distribution: { $ne: "assigned" } },
            {
                $or: [
                    { distribution: { $ne: "claimable" } },                // public_code: luôn hiện
                    { claimLimit: null },                                  // claimable không giới hạn lượt nhận
                    { $expr: { $lt: ["$claimedCount", "$claimLimit"] } },  // claimable còn lượt nhận
                    { _id: { $in: claimedIds } },                          // user đã nhận rồi
                ],
            },
        ],
    };

    // 4. Lấy dữ liệu trang hiện tại + tổng số bản ghi song song
    const [vouchers, total] = await Promise.all([
        Voucher.find(filter)
            .select("-applicableProducts -applicableCategories -createdBy")
            .sort({ displayOrder: 1, createdAt: -1, _id: 1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Voucher.countDocuments(filter),
    ]);

    // 5. Số lượt khách này đã dùng / đang giữ chỗ cho từng voucher trong trang
    //    (cùng điều kiện status với validateVoucher để FE và BE luôn khớp)
    let usedMap = new Map();
    if (req.user && vouchers.length) {
        const rows = await VoucherUsage.aggregate([
            {
                $match: {
                    user: req.user._id,
                    voucher: { $in: vouchers.map((v) => v._id) },
                    status: { $in: ["reserved", "used"] },
                },
            },
            { $group: { _id: "$voucher", count: { $sum: 1 } } },
        ]);
        usedMap = new Map(rows.map((r) => [String(r._id), r.count]));
    }

    // 6. Gắn cờ isClaimed / canClaim / usedByUser / isUsedUp
    const items = vouchers.map((v) => {
        const isClaimed = claimed.has(String(v._id));
        const usedByUser = usedMap.get(String(v._id)) ?? 0;
        return {
            ...v.toJSON(),
            isClaimed,
            usedByUser,
            isUsedUp: usedByUser >= v.usageLimitPerUser,
            canClaim: v.distribution === "claimable" && !v.isOutOfClaim && !isClaimed,
        };
    });

    const totalPages = Math.ceil(total / limit);

    res.json({
        items,
        pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
    });
};

// POST /vouchers/:id/claim
export const claim = async (req, res) => {
    await claimVoucher(req.params.id, req.user._id);
    res.status(201).json({ message: "Đã thêm voucher vào ví" });
};

// GET /vouchers/my?tab=available|used|expired   -> "Voucher của tôi"
export const myVouchers = async (req, res) => {
    const { tab = "available" } = req.query;
    const wallet = await UserVoucher.find({ user: req.user._id }).populate("voucher").sort({ createdAt: -1 });

    const items = wallet
        .filter((w) => w.voucher) // voucher có thể đã bị xóa
        .map((w) => {
            const v = w.voucher;
            let state = "available";
            if (w.usedCount >= v.usageLimitPerUser) state = "used";
            else if (v.isExpired || v.status !== "active" || v.isOutOfUsage) state = "expired";
            return { ...w.toJSON(), voucher: v.toJSON(), state };
        })
        .filter((w) => w.state === tab);
    res.json(items);
};

// POST /vouchers/validate   { code, items: [{productId, quantity}], shippingFee }
// Dùng ở giỏ hàng khi nhập mã / chọn voucher trong ví -> trả về số tiền giảm để hiển thị
export const validate = async (req, res) => {
    const { code, items, shippingFee = 0 } = req.body;
    const cart = await buildCart(items, shippingFee);
    const { voucher, discountAmount } = await validateVoucher(code, req.user._id, cart);
    res.json({ code: voucher.code, type: voucher.type, discountAmount, title: voucher.displayTitle });
};

// GET /vouchers/applicable?... (tùy chọn) gợi ý voucher tốt nhất cho giỏ hàng:
// lấy ví + public_code đang hiệu lực, thử validateVoucher từng cái (try/catch), sắp xếp theo discountAmount.