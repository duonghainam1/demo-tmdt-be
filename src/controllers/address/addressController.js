import mongoose from "mongoose";
import Addresses from "../../models/address/addressModel.js";

const MAX_ADDRESSES = 10; // mỗi user tối đa 10 địa chỉ
const PHONE_REGEX = /^(0|\+84)\d{9}$/;
const LABELS = ["home", "office", "other"];

// Chỉ lấy các field cho phép từ body (tránh client ghi đè user, _id...) và trim chuỗi
const buildPayload = (body = {}) => {
    // API hành chính trả code dạng số -> ép về chuỗi, nếu không provinceCode/wardCode sẽ bị rỗng
    const str = (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
    return {
        fullName: str(body.fullName),
        phone: str(body.phone),
        provinceCode: str(body.provinceCode),
        provinceName: str(body.provinceName),
        wardCode: str(body.wardCode),
        wardName: str(body.wardName),
        detail: str(body.detail),
        label: body.label ?? "home",
        isDefault: Boolean(body.isDefault),
    };
};

// Trả về chuỗi lỗi, hoặc null nếu hợp lệ
const validatePayload = (p) => {
    if (!p.fullName) return "Họ tên không được để trống";
    if (!p.phone) return "Số điện thoại không được để trống";
    if (!PHONE_REGEX.test(p.phone)) return "Số điện thoại không hợp lệ";
    if (!p.provinceCode || !p.provinceName) return "Vui lòng chọn tỉnh / thành phố";
    if (!p.wardCode || !p.wardName) return "Vui lòng chọn phường / xã";
    if (!p.detail) return "Địa chỉ cụ thể không được để trống";
    if (!LABELS.includes(p.label)) return "Loại địa chỉ không hợp lệ";
    return null;
};

const handleError = (res, error, tag) => {
    console.error(`${tag} error:`, error);

    // Vi phạm index "mỗi user 1 địa chỉ mặc định" (hiếm: 2 request đồng thời)
    if (error.code === 11000) {
        return res.status(409).json({ message: "Xung đột địa chỉ mặc định, vui lòng thử lại" });
    }
    if (error.name === "CastError") {
        return res.status(400).json({ message: "ID địa chỉ không hợp lệ" });
    }
    if (error.name === "ValidationError") {
        return res.status(400).json({ message: Object.values(error.errors)[0]?.message || "Dữ liệu không hợp lệ" });
    }
    return res.status(500).json({ message: "Internal server error" });
};

const invalidId = (res) => res.status(400).json({ message: "ID địa chỉ không hợp lệ" });

// Bỏ cờ mặc định của mọi địa chỉ khác của user (gọi TRƯỚC khi set cái mới để không vi phạm unique index)
const clearDefault = (userId, exceptId) =>
    Addresses.updateMany(
        { user: userId, isDefault: true, ...(exceptId && { _id: { $ne: exceptId } }) },
        { $set: { isDefault: false } }
    );

const addressController = {
    // ==========================================
    // GET MY ADDRESSES (mặc định lên đầu)
    // ==========================================
    getMyAddresses: async (req, res) => {
        try {
            const addresses = await Addresses.find({ user: req.user._id }).sort({
                isDefault: -1,
                createdAt: -1,
            });

            return res.status(200).json({
                message: "Lấy danh sách địa chỉ thành công",
                data: addresses,
            });
        } catch (error) {
            return handleError(res, error, "Get addresses");
        }
    },

    // ==========================================
    // CREATE ADDRESS
    // ==========================================
    createAddress: async (req, res) => {
        try {
            const userId = req.user._id;
            const payload = buildPayload(req.body ?? {});

            const errorMessage = validatePayload(payload);
            if (errorMessage) return res.status(400).json({ message: errorMessage });

            const count = await Addresses.countDocuments({ user: userId });
            if (count >= MAX_ADDRESSES) {
                return res.status(400).json({ message: `Chỉ được lưu tối đa ${MAX_ADDRESSES} địa chỉ` });
            }

            // Địa chỉ đầu tiên luôn là mặc định
            const makeDefault = count === 0 || payload.isDefault;
            if (makeDefault) await clearDefault(userId);

            const address = await Addresses.create({ ...payload, user: userId, isDefault: makeDefault });

            return res.status(201).json({
                message: "Thêm địa chỉ thành công",
                data: address,
            });
        } catch (error) {
            return handleError(res, error, "Create address");
        }
    },

    // ==========================================
    // UPDATE ADDRESS
    // ==========================================
    updateAddress: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return invalidId(res);

            const payload = buildPayload(req.body ?? {});
            const errorMessage = validatePayload(payload);
            if (errorMessage) return res.status(400).json({ message: errorMessage });

            // Lọc theo cả user để không sửa nhầm địa chỉ của người khác
            const address = await Addresses.findOne({ _id: id, user: req.user._id });
            if (!address) return res.status(404).json({ message: "Không tìm thấy địa chỉ" });

            const { isDefault, ...fields } = payload;
            Object.assign(address, fields);

            // Chỉ cho BẬT mặc định ở đây. Muốn đổi mặc định thì bật cho địa chỉ khác (luôn phải có 1 mặc định)
            if (isDefault && !address.isDefault) {
                await clearDefault(req.user._id, address._id);
                address.isDefault = true;
            }

            await address.save();

            return res.status(200).json({
                message: "Cập nhật địa chỉ thành công",
                data: address,
            });
        } catch (error) {
            return handleError(res, error, "Update address");
        }
    },

    // ==========================================
    // SET DEFAULT ADDRESS
    // ==========================================
    setDefaultAddress: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return invalidId(res);

            const address = await Addresses.findOne({ _id: id, user: req.user._id });
            if (!address) return res.status(404).json({ message: "Không tìm thấy địa chỉ" });

            if (!address.isDefault) {
                await clearDefault(req.user._id, address._id);
                address.isDefault = true;
                await address.save();
            }

            return res.status(200).json({
                message: "Đã đặt làm địa chỉ mặc định",
                data: address,
            });
        } catch (error) {
            return handleError(res, error, "Set default address");
        }
    },

    // ==========================================
    // DELETE ADDRESS
    // ==========================================
    deleteAddress: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return invalidId(res);

            const deleted = await Addresses.findOneAndDelete({ _id: id, user: req.user._id });
            if (!deleted) return res.status(404).json({ message: "Không tìm thấy địa chỉ" });

            // Xoá địa chỉ mặc định -> chuyển mặc định cho địa chỉ mới nhất còn lại
            if (deleted.isDefault) {
                const next = await Addresses.findOne({ user: req.user._id }).sort({ createdAt: -1 });
                if (next) {
                    next.isDefault = true;
                    await next.save();
                }
            }

            return res.status(200).json({ message: "Xoá địa chỉ thành công" });
        } catch (error) {
            return handleError(res, error, "Delete address");
        }
    },
};

export default addressController;