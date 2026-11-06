import { Router } from "express";
import productController from "../../controllers/product/productController.js";
import uploadMiddleware from "../../middlewares/uploadMiddleware.js";
import { can } from "../../middlewares/authMiddleware.js";

const router = Router();

// Public
router.get("/", productController.getProducts);
router.get("/:id", productController.getProductDetail);

// Admin
router.post("/", can("product:create"), uploadMiddleware.any(), productController.createProduct);
router.put("/:id", can("product:update"), uploadMiddleware.any(), productController.updateProduct);
router.post("/:productId/publish", can("product:update"), productController.publishProduct);

// Xoá mềm (chuyển vào thùng rác) và khôi phục
router.delete("/:id", can("product:delete"), productController.deleteProduct);
router.post("/:id/restore", can("product:update"), productController.restoreProduct);

export default router;