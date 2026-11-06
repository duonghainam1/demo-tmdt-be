import { Router } from "express";
import addressController from "../../controllers/address/addressController.js";
import { loggedIn } from "../../middlewares/authMiddleware.js";

const router = Router();

// Địa chỉ là dữ liệu cá nhân: chỉ cần đăng nhập, controller tự lọc theo req.user._id
router.use(loggedIn);

router.get("/", addressController.getMyAddresses);
router.post("/", addressController.createAddress);
router.put("/:id", addressController.updateAddress);
router.patch("/:id/default", addressController.setDefaultAddress);
router.delete("/:id", addressController.deleteAddress);

export default router;