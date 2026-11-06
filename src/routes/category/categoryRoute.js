import { Router } from "express";
import categoryController from "../../controllers/category/categoryController.js";
import { can } from "../../middlewares/authMiddleware.js";
import uploadMiddleware from "../../middlewares/uploadMiddleware.js";
import { getFiltersByCategory } from "../../controllers/filters/FiltersController.js";

const router = Router();

// Public
router.get("/", categoryController.getCategories);
router.get("/:slug", getFiltersByCategory);

// Admin
router.post("/", can("category:create"), uploadMiddleware.single("image"), categoryController.createCategory);
router.put("/:id", can("category:update"), uploadMiddleware.single("image"), categoryController.updateCategory);
router.delete("/:id", can("category:delete"), categoryController.deleteCategory);

export default router;