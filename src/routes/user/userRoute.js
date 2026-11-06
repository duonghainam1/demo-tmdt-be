import { Router } from "express";
import userController from "../../controllers/user/userController.js";
import authMiddleware, { can, requireRole } from "../../middlewares/authMiddleware.js";
import uploadMiddleware from "../../middlewares/uploadMiddleware.js";

const router = Router();

// Người dùng tự thao tác trên tài khoản của mình
router.get("/profile", authMiddleware, userController.getUserProfile);
router.put(
  "/profile",
  authMiddleware,
  uploadMiddleware.single("avatar"),
  userController.updateUserProfile
);

// Admin / nhân viên
router.get("/all", can("user:read"), userController.getAllUsers);
router.patch(
  "/:id/role",
  authMiddleware,
  requireRole("ADMIN"),
  userController.updateUserRole
);

export default router;