import express from "express";
import bannerController from "../../controllers/banner/bannerController.js";
import uploadMiddleware from "../../middlewares/uploadMiddleware.js";
import { can } from "../../middlewares/authMiddleware.js";

const router = express.Router();

/* ---------- Upload ảnh banner ---------- */
const uploadImage = (req, res, next) => {
  uploadMiddleware.single("image")(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "Ảnh không được vượt quá 5MB" : err.message;
    res.status(400).json({ message });
  });
};

// Siết lại theo giao diện: JPG/PNG/WebP và ≤ 2MB. Chỉ chạy khi có file.
const validateBannerImage = (req, res, next) => {
  if (!req.file) return next();
  if (!["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype)) {
    return res.status(400).json({ message: "Chỉ chấp nhận ảnh JPG, PNG hoặc WebP" });
  }
  if (req.file.size > 2 * 1024 * 1024) {
    return res.status(400).json({ message: "Ảnh banner không được vượt quá 2MB" });
  }
  next();
};

/* ---------- Public (trang chủ) ---------- */
router.get("/public", bannerController.getPublicBanners);

/* ---------- Admin ---------- */
router.get("/", can("banner:read"), bannerController.getBanners);
router.post("/", can("banner:create"), uploadImage, validateBannerImage, bannerController.createBanner);

// Các route cố định phải đặt TRƯỚC "/:id"
router.patch("/reorder", can("banner:update"), bannerController.reorderBanners);

router.get("/:id", can("banner:read"), bannerController.getBannerById);
router.put("/:id", can("banner:update"), uploadImage, validateBannerImage, bannerController.updateBanner);
router.patch("/:id/toggle", can("banner:update"), bannerController.toggleBanner);
router.patch("/:id/move", can("banner:update"), bannerController.moveBanner);
router.delete("/:id", can("banner:delete"), bannerController.deleteBanner);

export default router;