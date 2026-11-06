import mongoose from "mongoose";

/* ================= Helpers ================= */

// Lấy mã video (11 ký tự) từ mọi dạng link YouTube thường gặp:
//   https://www.youtube.com/watch?v=XXXXXXXXXXX
//   https://youtu.be/XXXXXXXXXXX
//   https://www.youtube.com/shorts/XXXXXXXXXXX
//   https://www.youtube.com/embed/XXXXXXXXXXX
//   hoặc chính mã video 11 ký tự
// Không đúng định dạng -> null
const ID_REGEX = /^[\w-]{11}$/;

export const extractYoutubeId = (input) => {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  if (ID_REGEX.test(raw)) return raw;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id = null;

  if (host === "youtu.be") {
    id = url.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const [, kind, vid] = url.pathname.split("/"); // /shorts/ID, /embed/ID, /live/ID
      if (["shorts", "embed", "live", "v"].includes(kind)) id = vid;
    }
  }

  return id && ID_REGEX.test(id) ? id : null;
};

/* ================= Schema ================= */

const reviewVideoSchema = new mongoose.Schema(
  {
    // Link admin dán vào; mã video được tự tách ra ở pre-validate
    youtubeUrl: { type: String, trim: true },

    // Mã video 11 ký tự, dùng để nhúng iframe và lấy ảnh bìa. Mỗi video chỉ xuất hiện 1 lần
    // (sparse: bản ghi chưa tách được mã thì không bị tính trùng nhau)
    videoId: { type: String, trim: true, unique: true, sparse: true },

    title: { type: String, trim: true },

    // Tên kênh hiện ở góc trên ảnh bìa (tuỳ chọn)
    channelName: { type: String, trim: true, default: "" },

    // Ảnh bìa riêng (tuỳ chọn, tải lên Cloudinary). Không có thì lấy ảnh mặc định của YouTube
    thumbnail: {
      url: { type: String, default: undefined },
      publicId: { type: String, default: undefined },
    },

    // Thứ tự hiển thị (nhỏ lên trước)
    order: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },

    // Lịch hiển thị (tuỳ chọn). null = không giới hạn
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ================= Index ================= */

reviewVideoSchema.index({ isActive: 1, order: 1 });

/* ================= Virtuals ================= */

// Ảnh bìa dùng để hiển thị: ảnh riêng nếu có, không thì ảnh YouTube
reviewVideoSchema.virtual("thumbnailUrl").get(function () {
  if (this.thumbnail?.url) return this.thumbnail.url;
  return this.videoId ? `https://i.ytimg.com/vi/${this.videoId}/hqdefault.jpg` : null;
});

// Trạng thái hiển thị: inactive | scheduled | expired | active
reviewVideoSchema.virtual("status").get(function () {
  const now = new Date();
  if (!this.isActive) return "inactive";
  if (this.startAt && this.startAt > now) return "scheduled";
  if (this.endAt && this.endAt < now) return "expired";
  return "active";
});

/* ================= Hooks ================= */

// Tách mã video từ link (tạm thời không validate: link sai thì videoId để trống)
// Mongoose 9 không còn truyền `next` vào pre hook -> hook đồng bộ chỉ cần return,
// không gọi next() (gọi sẽ lỗi "next is not a function").
reviewVideoSchema.pre("validate", function () {
  if (this.isModified("youtubeUrl") || !this.videoId) {
    const id = extractYoutubeId(this.youtubeUrl);
    if (id) this.videoId = id;
  }
});

/* ================= Statics ================= */

// Video hiển thị ở trang chủ: đang bật và nằm trong thời gian hiển thị, sắp theo thứ tự
reviewVideoSchema.statics.findPublic = function () {
  const now = new Date();
  return this.find({
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
    ],
  }).sort({ order: 1, createdAt: -1 });
};

const ReviewVideo = mongoose.models.ReviewVideo || mongoose.model("ReviewVideo", reviewVideoSchema);

export default ReviewVideo;