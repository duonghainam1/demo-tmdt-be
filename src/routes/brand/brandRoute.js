import { Router } from "express";
import brandController from "../../controllers/brand/brandController.js";
import uploadMiddleware from "../../middlewares/uploadMiddleware.js";
import { can } from "../../middlewares/authMiddleware.js";

const router = Router();

router.get("/", brandController.getAllBrands); // public cho storefront
router.post("/", can("brand:create"), uploadMiddleware.single("logo"), brandController.createBrand);
router.put("/:id", can("brand:update"), uploadMiddleware.single("logo"), brandController.updateBrand);
router.delete("/:id", can("brand:delete"), brandController.deleteBrand);

export default router;