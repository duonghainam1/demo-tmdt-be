import mongoose from "mongoose";

/* ================= Hằng số & helpers ================= */

// Khớp với danh mục ở form (NEWS_CATEGORIES bên frontend)
export const NEWS_CATEGORIES = ["promotion", "review", "tips", "tech"];

// "Tiêu đề Tiếng Việt" -> "tieu-de-tieng-viet"
export const slugify = (s = "") =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Điều kiện Mongo của bài đang hiển thị ở trang chủ: bật + nằm trong thời gian hiển thị
export const publicFilter = (now = new Date()) => ({
  isActive: true,
  $and: [
    { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
    { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
  ],
});

/* ================= Schema ================= */

const newsSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: [120, "Tiêu đề tối đa 120 ký tự"] },

    // Đường dẫn bài viết: /tin-tuc/<slug>. Tự tạo từ tiêu đề, không trùng nhau
    slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

    summary: { type: String, trim: true, default: "", maxlength: [200, "Mô tả ngắn tối đa 200 ký tự"] },

    category: {
      type: String,
      enum: { values: NEWS_CATEGORIES, message: "Danh mục không hợp lệ" },
      default: undefined,
    },

    // Nội dung HTML từ trình soạn thảo
    content: { type: String, default: "" },

    // Ảnh bìa (tải lên Cloudinary)
    thumbnail: {
      url: { type: String, default: undefined },
      publicId: { type: String, default: undefined },
    },

    // Thứ tự hiển thị (nhỏ lên trước)
    order: { type: Number, default: 0 },

    // Công tắc "Hiển thị trên trang chủ"
    isActive: { type: Boolean, default: true },

    // Đã từng được hiển thị ít nhất một lần -> phân biệt "Bản nháp" (chưa bao giờ) và "Đã ẩn" (từng hiển thị)
    hasPublished: { type: Boolean, default: false },

    // Nổi bật: ưu tiên ở đầu danh sách trang chủ
    isFeatured: { type: Boolean, default: false },

    // Lịch hiển thị (tuỳ chọn). null = không giới hạn
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ================= Index ================= */

newsSchema.index({ isActive: 1, isFeatured: -1, order: 1 });

/* ================= Virtuals ================= */

// Ảnh bìa để hiển thị (null nếu chưa có ảnh)
newsSchema.virtual("thumbnailUrl").get(function () {
  return this.thumbnail?.url || null;
});

// Trạng thái: draft | hidden | scheduled | expired | published
newsSchema.virtual("status").get(function () {
  const now = new Date();
  if (!this.isActive) return this.hasPublished ? "hidden" : "draft";
  if (this.startAt && this.startAt > now) return "scheduled";
  if (this.endAt && this.endAt < now) return "expired";
  return "published";
});

/* ================= Statics ================= */

// Bài hiển thị ở trang chủ: nổi bật lên trước, rồi theo thứ tự
newsSchema.statics.findPublic = function () {
  return this.find(publicFilter()).sort({ isFeatured: -1, order: 1, createdAt: -1 });
};

const News = mongoose.models.News || mongoose.model("News", newsSchema);

export default News;