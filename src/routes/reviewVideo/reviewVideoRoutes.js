import express from "express";
import reviewVideoController from "../../controllers/reviewVideo/reviewVideoController.js"; // TODO: chỉnh đường dẫn
import upload from "../../middlewares/uploadMiddleware.js"; // TODO: chỉnh đúng tên file multer của bạn
import { loggedIn } from "../../middlewares/authMiddleware.js"; // TODO: chỉnh đúng tên file auth của bạn
import adminMiddleware from "../../middlewares/adminMiddleware.js"; // TODO: chỉnh đúng tên file admin của bạn

const router = express.Router();

const {
  createReviewVideo,
  getReviewVideos,
  getPublicReviewVideos,
  getReviewVideoById,
  updateReviewVideo,
  toggleReviewVideo,
  reorderReviewVideos,
  moveReviewVideo,
  deleteReviewVideo,
} = reviewVideoController;

// Bọc multer để lỗi upload trả về JSON 400 thay vì lỗi 500 mặc định của Express
const uploadThumbnail = (req, res, next) =>
  upload.single("thumbnail")(req, res, (err) => {
    if (!err) return next();

    let message = "Tải ảnh lên thất bại";
    if (err.code === "LIMIT_FILE_SIZE") message = "Ảnh tối đa 10MB";
    else if (err.code === "LIMIT_UNEXPECTED_FILE") message = 'Sai tên field ảnh (phải là "thumbnail")';
    else if (err.message === "Only image files are allowed!") message = "Chỉ chấp nhận file ảnh";

    return res.status(400).json({ message });
  });

/* ---------- Công khai (trang chủ, không cần đăng nhập) ---------- */
router.get("/public", getPublicReviewVideos);

/* ---------- Quản trị: đăng nhập + role ADMIN cho mọi route bên dưới ---------- */
// Thứ tự bắt buộc: loggedIn (gắn req.user) rồi mới tới adminMiddleware (đọc req.user.role.code)
router.use(loggedIn, adminMiddleware);

// Route cố định (/reorder) phải đặt TRƯỚC các route có /:id
router.patch("/reorder", reorderReviewVideos);

router.get("/", getReviewVideos);
router.post("/", uploadThumbnail, createReviewVideo);

router.get("/:id", getReviewVideoById);
router.put("/:id", uploadThumbnail, updateReviewVideo);
router.patch("/:id/toggle", toggleReviewVideo);
router.patch("/:id/move", moveReviewVideo);
router.delete("/:id", deleteReviewVideo);

export default router;

// Gắn vào app (server.js / app.js):
//   import reviewVideoRoutes from "./routes/reviewVideo/reviewVideoRoutes.js";
//   app.use("/api/review-videos", reviewVideoRoutes);