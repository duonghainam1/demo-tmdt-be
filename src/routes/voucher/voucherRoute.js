import { Router } from "express";
import * as admin from "../../controllers/voucher/voucherAdminController.js";
import * as client from "../../controllers/voucher/voucherClientController.js";
import * as options from "../../controllers/voucher/voucheroptionsController.js";
// TODO: sửa đường dẫn cho đúng tên file middleware của bạn
import authMiddleware, { optionalAuth } from "../../middlewares/authMiddleware.js";
import adminMiddleware from "../../middlewares/adminMiddleware.js";

// Wrapper để lỗi async rơi vào error handler (express 4)
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- ADMIN: app.use("/api/admin/vouchers", voucherRoutes.adminRouter) ----------
const adminRouter = Router();
// Thứ tự quan trọng: authMiddleware chạy trước để có req.user, rồi adminMiddleware mới kiểm tra role
adminRouter.use(authMiddleware, adminMiddleware);
adminRouter.get("/", wrap(admin.list));
adminRouter.post("/", wrap(admin.create));
adminRouter.get("/options/products", wrap(options.getProductOptions)); // lấy danh sách options cho form tạo/sửa voucher
adminRouter.get("/options/categories", wrap(options.getCategoryOptions)); // lấy danh sách options cho form tạo/sửa voucher
adminRouter.get("/:id", wrap(admin.detail));
adminRouter.put("/:id", wrap(admin.update));
adminRouter.patch("/:id/status", wrap(admin.changeStatus));
adminRouter.delete("/:id", wrap(admin.remove));
adminRouter.post("/:id/assign", wrap(admin.assign));
adminRouter.get("/:id/usages", wrap(admin.usages));
adminRouter.get("/:id/stats", wrap(admin.stats));

// ---------- CLIENT: app.use("/api/vouchers", voucherRoutes.clientRouter) ----------
const clientRouter = Router();
// Khách chưa đăng nhập vẫn xem được danh sách; nếu đã đăng nhập thì có thêm isClaimed / canClaim
clientRouter.get("/", optionalAuth, wrap(client.listPublic));
// Các route dưới đây cần đăng nhập (controller dùng req.user._id)
clientRouter.get("/my", authMiddleware, wrap(client.myVouchers)); // phải đặt trước /:id
clientRouter.post("/validate", authMiddleware, wrap(client.validate));
clientRouter.post("/:id/claim", authMiddleware, wrap(client.claim));

export default { adminRouter, clientRouter };