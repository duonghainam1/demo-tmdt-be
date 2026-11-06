import { Router } from "express";
import rateLimit from "express-rate-limit"; // npm i express-rate-limit
import repairRequestController from "../../controllers/repairrequest/repairrequestController.js";
import technicianTaskController from "../../controllers/repairrequest/technicianTaskController.js";
import {
    lookupWarranty,
    getMyWarranties,
} from "../../controllers/repairrequest/unifiedWarrantyController.js"; // bảo hành gộp: sản phẩm đã bán + sửa chữa
import { can, loggedIn, requireAnyPermission } from "../../middlewares/authMiddleware.js";

const router = Router();

// Giới hạn tra cứu công khai: 30 lần / 15 phút / IP, tránh dò SĐT / mã đơn hàng loạt
const publicLookupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Bạn tra cứu quá nhiều lần, vui lòng thử lại sau ít phút" },
});

/* =====================================================================================
 *  LƯU Ý THỨ TỰ: các route cố định (/my, /track, /warranty, /manage, /technicians, /parts, /my-tasks)
 *  phải khai báo TRƯỚC "/:id", nếu không chúng sẽ bị hiểu là một id.
 * ===================================================================================== */

/* ----------------------------- Khách hàng (chỉ cần đăng nhập) ----------------------------- */
router.post("/", loggedIn, repairRequestController.createRepairRequest); // gửi yêu cầu
router.get("/my", loggedIn, repairRequestController.getMyRepairRequests); // xem yêu cầu của mình
router.post("/:id/rating", loggedIn, repairRequestController.rateRepairRequest); // đánh giá (controller tự kiểm tra chủ đơn)

// Bảo hành của tôi: gộp sản phẩm đã mua + sửa chữa (đặt TRƯỚC /warranty/:...)
router.get("/warranty/my", loggedIn, getMyWarranties);

/* ----------------------------- Public (không cần đăng nhập) ----------------------------- */
router.get("/track", publicLookupLimiter, repairRequestController.trackRepairRequests); // ?keyword=SC-... | SĐT
// Tra cứu bảo hành gộp: ?code=<mã đơn NX... + phone | SC-... | IMEI | Serial>&phone=
router.get("/warranty", publicLookupLimiter, lookupWarranty);

/* ----------------------------- Công việc của kỹ thuật viên (PHẦN 3) -----------------------------
 * repair:task      -> xử lý đơn được giao cho mình
 * repair:task-all  -> xem/xử lý đơn của mọi nhân viên (controller tự giới hạn phạm vi theo quyền) */
const taskAccess = [loggedIn, requireAnyPermission("repair:task", "repair:task-all")];

router.get("/my-tasks", taskAccess, technicianTaskController.getMyTasks);
router.get("/my-tasks/:id", taskAccess, technicianTaskController.getMyTaskById);
router.patch("/my-tasks/:id/status", taskAccess, technicianTaskController.updateMyTaskStatus);
router.patch("/my-tasks/:id/update", taskAccess, technicianTaskController.updateMyTaskInfo);

/* ----------------------------- Admin: Yêu cầu sửa chữa (PHẦN 1) ----------------------------- */
router.get("/", can("repair:read"), repairRequestController.getRepairRequests); // ?status=pending,rejected&...
router.patch("/:id/confirm", can("repair:update"), repairRequestController.confirmRepairRequest);
router.patch("/:id/reject", can("repair:update"), repairRequestController.rejectRepairRequest);

/* ----------------------------- Admin: Quản lý sửa chữa (PHẦN 2) ----------------------------- */
router.get("/manage", can("repair:read"), repairRequestController.getManagedRequests);
// Cả người phân công lẫn người xem việc của mọi nhân viên (cho ô lọc) đều cần danh sách này
router.get(
    "/technicians",
    loggedIn,
    requireAnyPermission("repair:assign", "repair:task-all"),
    repairRequestController.getTechnicians
);
// Danh sách linh kiện trong kho để chọn khi xử lý đơn (admin + kỹ thuật viên)
router.get(
    "/parts",
    loggedIn,
    requireAnyPermission("repair:update", "repair:task", "repair:task-all"),
    repairRequestController.getPartOptions
);

router.patch("/:id/assign", can("repair:assign"), repairRequestController.assignTechnician);
router.patch("/:id/status", can("repair:update"), repairRequestController.updateRepairStatus);
router.patch("/:id/update", can("repair:update"), repairRequestController.updateRepairInfo);
router.patch("/:id/payment", can("repair:payment"), repairRequestController.updatePayment);

/* ----------------------------- Dùng chung (đặt cuối để không nuốt route cố định) ----------------------------- */
router.get("/:id", can("repair:read"), repairRequestController.getRepairRequestById);

// Xoá mềm (chỉ completed / cancelled / rejected)
router.delete("/:id", can("repair:delete"), repairRequestController.deleteRepairRequest);

export default router;