import jwt from "jsonwebtoken";
import Users from "../models/users/userModel.js";

const authMiddleware = async (req, res, next) => {
  try {
    // Lấy token từ header Authorization: "Bearer <token>"
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Xác thực access token
    let decodeUser;
    try {
      decodeUser = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
      // Hết hạn hoặc không hợp lệ -> 401 để frontend tự gọi refresh token
      return res.status(401).json({
        message:
          err.name === "TokenExpiredError"
            ? "Access token expired"
            : "Invalid access token",
      });
    }

    // Lấy user từ DB, bỏ password, populate role để có code + permissions mới nhất
    const user = await Users.findById(decodeUser.id)
      .select("-password")
      .populate("role", "name code permissions isActive");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Role bị xóa hoặc bị vô hiệu hóa -> 403 (không dùng 401 để frontend không lặp refresh)
    if (!user.role || !user.role.isActive) {
      return res.status(403).json({ message: "Role is inactive or missing" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// MỚI - Đăng nhập tùy chọn: có token hợp lệ thì gắn req.user, không thì coi như khách và đi tiếp.
// Dùng cho route công khai nhưng muốn biết người xem là ai (vd: danh sách voucher có trạng thái "Đã nhận").
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    if (token) {
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      const user = await Users.findById(decoded.id)
        .select("-password")
        .populate("role", "name code permissions isActive");
      if (user && user.role?.isActive) req.user = user;
    }
  } catch {
    // token sai hoặc hết hạn: bỏ qua, xử lý như khách chưa đăng nhập
  }
  next();
};

// Kiểm tra theo code của role: requireRole("ADMIN") hoặc requireRole("ADMIN", "MANAGER")
export const requireRole =
  (...codes) =>
  (req, res, next) => {
    const code = req.user?.role?.code;
    if (!code || !codes.includes(code)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };

// Phải có ĐỦ tất cả quyền trong danh sách. Role có "*" thì được toàn quyền
export const requirePermission =
  (...required) =>
  (req, res, next) => {
    const permissions = req.user?.role?.permissions || [];

    if (permissions.includes("*")) return next();

    const ok = required.every((p) => permissions.includes(p));
    if (!ok) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };

// Chỉ cần có ÍT NHẤT MỘT quyền trong danh sách
export const requireAnyPermission =
  (...allowed) =>
  (req, res, next) => {
    const permissions = req.user?.role?.permissions || [];
    if (permissions.includes("*") || allowed.some((p) => permissions.includes(p))) {
      return next();
    }
    return res.status(403).json({ message: "Forbidden" });
  };

// Rút gọn: đăng nhập + kiểm tra quyền trong một lần
// Dùng: router.post("/", can("product:create"), controller.create)
export const can = (...perms) => [authMiddleware, requirePermission(...perms)];

// Chỉ đăng nhập, không cần quyền cụ thể (dùng cho router.use)
export const loggedIn = authMiddleware;

export default authMiddleware;