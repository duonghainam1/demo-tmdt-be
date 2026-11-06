import Users from "../models/users/userModel.js"; // chỉnh path
import { TECHNICIAN_ROLE_CODES } from "../models/repairr/repairrequestMode.js"; // chỉnh path

// Chỉ cho nhân viên kỹ thuật (role nằm trong TECHNICIAN_ROLE_CODES, đang hoạt động) đi tiếp.
// Đặt SAU loggedIn.
const technicianMiddleware = async (req, res, next) => {
    try {
        const userId = req.user?._id || req.user?.id;
        const user = await Users.findById(userId)
            .select("role")
            .populate({ path: "role", select: "code isActive" });

        if (!user?.role?.isActive || !TECHNICIAN_ROLE_CODES.includes(user.role.code)) {
            return res.status(403).json({ message: "Chỉ dành cho kỹ thuật viên" });
        }
        return next();
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Lỗi server" });
    }
};

export default technicianMiddleware;