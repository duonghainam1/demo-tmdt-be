import express from "express";
import {
  getProductVariants,
  createProductVariant,
  updateProductVariant,
  updateVariantPricing,
  deleteProductVariant,
} from "../../controllers/product/productVariantController.js";
import upload from "../../middlewares/uploadMiddleware.js"; // multer dùng memoryStorage
import { can } from "../../middlewares/authMiddleware.js";

const router = express.Router();

// GET /api/product-variants/test?product=&sku=&search=&isActive=&page=&limit=
router.get("/test", can("sku:read"), getProductVariants); // "/test" giữ tạm cho FE cũ

// POST (multipart: ảnh ở field "image")
router.post("/", can("sku:create"), upload.single("image"), createProductVariant);

// PUT /:variantId (multipart: ảnh ở field "image")
router.put("/:variantId", can("sku:update"), upload.single("image"), updateProductVariant);

// PUT /:variantId/pricing (JSON) - chỉ sửa giá
router.put("/:variantId/pricing", can("sku:update"), updateVariantPricing);

// DELETE /:variantId
router.delete("/:variantId", can("sku:delete"), deleteProductVariant);

export default router;