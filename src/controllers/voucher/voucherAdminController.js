import Voucher from "../../models/voucher/voucherModel.js";
import UserVoucher from "../../models/voucher/userVoucherModel.js";
import VoucherUsage from "../../models/voucher/voucherUsageModel.js";
import { httpError } from "../../services/voucher/voucherService.js";

// Field admin được phép gửi lên (không cho sửa usedCount/claimedCount/createdBy)
const EDITABLE = [
    "code", "name", "description", "type", "value", "maxDiscount", "minOrderValue",
    "applyTo", "applicableProducts", "applicableCategories", "audience", "distribution",
    "isPublic", "displayOrder", "startDate", "endDate", "usageLimit", "usageLimitPerUser",
    "claimLimit", "isStackable", "status",
];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

// GET /admin/vouchers?page=&limit=&keyword=&status=&type=&state=running|upcoming|expired
export const list = async (req, res) => {
    const { page = 1, limit = 20, keyword, status, type, state } = req.query;
    const now = new Date();
    const filter = {};
    if (keyword) filter.$or = [
        { code: new RegExp(keyword.trim(), "i") },
        { name: new RegExp(keyword.trim(), "i") },
    ];
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (state === "running") Object.assign(filter, { startDate: { $lte: now }, endDate: { $gte: now } });
    if (state === "upcoming") filter.startDate = { $gt: now };
    if (state === "expired") filter.endDate = { $lt: now };

    const [items, total] = await Promise.all([
        Voucher.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit),
        Voucher.countDocuments(filter),
    ]);
    res.json({ items, total, page: +page, limit: +limit });
};

// GET /admin/vouchers/:id
export const detail = async (req, res) => {
    const voucher = await Voucher.findById(req.params.id)
        .populate("applicableProducts", "name thumbnail")
        .populate("applicableCategories", "name");
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");
    res.json(voucher);
};

// POST /admin/vouchers
export const create = async (req, res) => {
    try {
        const voucher = await Voucher.create({ ...pick(req.body, EDITABLE), createdBy: req.user._id });
        res.status(201).json(voucher);
    } catch (err) {
        if (err.code === 11000) throw httpError(409, "Mã voucher đã tồn tại");
        throw err;
    }
};

// PUT /admin/vouchers/:id
// Dùng get -> set -> save (KHÔNG dùng findByIdAndUpdate) để pre("validate") liên trường chạy đúng
export const update = async (req, res) => {
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");

    const data = pick(req.body, EDITABLE);
    if (voucher.usedCount > 0 || voucher.claimedCount > 0) {
        // đã có người dùng/nhận thì không được đổi bản chất voucher
        for (const k of ["code", "type", "distribution", "audience"]) delete data[k];
    }
    voucher.set(data);
    await voucher.save();
    res.json(voucher);
};

// PATCH /admin/vouchers/:id/status   { status: "active" | "paused" | "draft" }
export const changeStatus = async (req, res) => {
    const { status } = req.body;
    if (!["draft", "active", "paused"].includes(status)) throw httpError(400, "Trạng thái không hợp lệ");
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");
    voucher.status = status;
    await voucher.save();
    res.json(voucher);
};

// DELETE /admin/vouchers/:id  (đã phát sinh dữ liệu thì chỉ cho tạm dừng)
export const remove = async (req, res) => {
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");
    const hasUsage = await VoucherUsage.exists({ voucher: voucher._id });
    if (hasUsage || voucher.claimedCount > 0) {
        throw httpError(400, "Voucher đã có người nhận/dùng, hãy chuyển sang trạng thái tạm dừng");
    }
    await voucher.deleteOne();
    await UserVoucher.deleteMany({ voucher: voucher._id });
    res.json({ message: "Đã xóa voucher" });
};

// POST /admin/vouchers/:id/assign   { userIds: [] }  -> tặng thẳng vào ví
export const assign = async (req, res) => {
    const { userIds = [] } = req.body;
    if (!userIds.length) throw httpError(400, "Chưa chọn người dùng");
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");
    if (voucher.distribution === "public_code") throw httpError(400, "Voucher mã công khai không cần tặng vào ví");

    const result = await UserVoucher.bulkWrite(
        userIds.map((u) => ({
            updateOne: {
                filter: { user: u, voucher: voucher._id },
                update: { $setOnInsert: { source: "assigned", claimedAt: new Date() } },
                upsert: true, // đã có trong ví thì bỏ qua
            },
        }))
    );
    res.json({ assigned: result.upsertedCount, skipped: userIds.length - result.upsertedCount });
};

// GET /admin/vouchers/:id/usages?status=&page=&limit=
export const usages = async (req, res) => {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { voucher: req.params.id, ...(status && { status }) };
    const [items, total] = await Promise.all([
        VoucherUsage.find(filter)
            .populate("user", "name email")
            .populate("order", "code totalAmount")
            .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit),
        VoucherUsage.countDocuments(filter),
    ]);
    res.json({ items, total, page: +page, limit: +limit });
};

// GET /admin/vouchers/:id/stats
export const stats = async (req, res) => {
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw httpError(404, "Không tìm thấy voucher");
    const [agg] = await VoucherUsage.aggregate([
        { $match: { voucher: voucher._id, status: { $in: ["reserved", "used"] } } },
        { $group: { _id: null, totalDiscount: { $sum: "$discountAmount" }, orders: { $sum: 1 } } },
    ]);
    res.json({
        usedCount: voucher.usedCount, usageLimit: voucher.usageLimit,
        claimedCount: voucher.claimedCount, claimLimit: voucher.claimLimit,
        totalDiscount: agg?.totalDiscount || 0, orders: agg?.orders || 0,
    });
};