import { Router } from "express";
import newsController from "../../controllers/news/newsController.js"; // TODO: chỉnh đường dẫn
import upload from "../../middlewares/uploadMiddleware.js"; // TODO: chỉnh đúng tên file multer của bạn
import { loggedIn } from "../../middlewares/authMiddleware.js"; // TODO: chỉnh đúng tên file auth của bạn
import adminMiddleware from "../../middlewares/adminMiddleware.js"; // TODO: chỉnh đúng tên file admin của bạn

const router = Router();

const {
  createNews,
  getNews,
  getPublicNews,
  getPublicNewsBySlug,
  getNewsById,
  updateNews,
  toggleNews,
  reorderNews,
  moveNews,
  deleteNews,
} = newsController;

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

/* ---------- Công khai (trang chủ + trang chi tiết, không cần đăng nhập) ---------- */
router.get("/public", getPublicNews);
router.get("/public/:slug", getPublicNewsBySlug);

/* ---------- Quản trị: đăng nhập + role ADMIN cho mọi route bên dưới ---------- */
// Thứ tự bắt buộc: loggedIn (gắn req.user) rồi mới tới adminMiddleware (đọc req.user.role.code)
router.use(loggedIn, adminMiddleware);

// Route cố định (/reorder) phải đặt TRƯỚC các route có /:id
router.patch("/reorder", reorderNews);

router.get("/", getNews);
router.post("/", uploadThumbnail, createNews);

router.get("/:id", getNewsById);
router.put("/:id", uploadThumbnail, updateNews);
router.patch("/:id/toggle", toggleNews);
router.patch("/:id/move", moveNews);
router.delete("/:id", deleteNews);

export default router;

// Gắn vào app (server.js / app.js):
//   import newsRoutes from "./routes/news/newsRoutes.js";
//   app.use("/api/news", newsRoutes);