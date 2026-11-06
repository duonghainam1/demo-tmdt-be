import mongoose from "mongoose";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js"; // TODO: chỉnh đường dẫn
import ReviewVideo, { extractYoutubeId } from "../../models/reviewVideo/reviewVideoModel.js"; // TODO: chỉnh đường dẫn

const FOLDER = "review-videos";

/* ================= Helpers ================= */

// "true"/"false" (multipart/form-data gửi chuỗi) -> boolean
const toBool = (v, fallback) => {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
};

// "" / null -> null, chuỗi ngày -> Date, sai định dạng -> "invalid", không gửi -> undefined (giữ nguyên)
const parseDate = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? "invalid" : d;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Chuẩn hoá lỗi: validate của mongoose -> 400, trùng videoId -> 409
const handleError = (res, error) => {
  if (error.name === "ValidationError") {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ message: messages[0], errors: messages });
  }
  if (error.code === 11000) {
    return res.status(409).json({ message: "Video này đã có trong danh sách" });
  }
  console.log(error);
  return res.status(500).json({ message: "Lỗi server" });
};

// Điều kiện Mongo cho từng trạng thái
const statusFilter = (status, now = new Date()) => {
  switch (status) {
    case "inactive":
      return { isActive: false };
    case "scheduled":
      return { isActive: true, startAt: { $gt: now } };
    case "expired":
      return { isActive: true, endAt: { $lt: now } };
    case "active":
      return {
        isActive: true,
        $and: [
          { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
          { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
        ],
      };
    default:
      return {};
  }
};

// Gộp thứ tự lại 1..n (sau khi xoá / trước khi di chuyển)
const compactOrders = async () => {
  const all = await ReviewVideo.find().sort({ order: 1, createdAt: -1 }).select("_id");
  if (!all.length) return;
  await ReviewVideo.bulkWrite(
    all.map((v, i) => ({
      updateOne: { filter: { _id: v._id }, update: { $set: { order: i + 1 } } },
    }))
  );
};

// Thứ tự kế tiếp (cuối danh sách)
const nextOrder = async () => {
  const last = await ReviewVideo.findOne().sort({ order: -1 }).select("order");
  return last ? last.order + 1 : 1;
};

/* ================= Controller ================= */

const reviewVideoController = {
  // POST /api/review-videos  (multipart/form-data, field ảnh bìa riêng: "thumbnail" - tuỳ chọn)
  // body: youtubeUrl, title, channelName?, order?, isActive?, startAt?, endAt?
  createReviewVideo: async (req, res) => {
    let uploaded = null;
    try {
      const { youtubeUrl, title, channelName, order, isActive } = req.body;

      // Kiểm tra tối thiểu ở controller (model tạm thời không validate)
      const videoId = extractYoutubeId(youtubeUrl);
      if (!videoId) return res.status(400).json({ message: "Link YouTube không hợp lệ" });
      if (!title || !title.trim()) {
        return res.status(400).json({ message: "Vui lòng nhập tiêu đề video" });
      }

      if (await ReviewVideo.exists({ videoId })) {
        return res.status(409).json({ message: "Video này đã có trong danh sách" });
      }

      const startAt = parseDate(req.body.startAt);
      const endAt = parseDate(req.body.endAt);
      if (startAt === "invalid" || endAt === "invalid") {
        return res.status(400).json({ message: "Thời gian không hợp lệ" });
      }
      if (startAt && endAt && endAt <= startAt) {
        return res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      }

      const data = {
        youtubeUrl,
        videoId,
        title,
        channelName,
        order: order !== undefined && order !== "" ? Number(order) : await nextOrder(),
        isActive: toBool(isActive, true),
        startAt: startAt ?? null,
        endAt: endAt ?? null,
      };

      // Ảnh bìa riêng (tuỳ chọn): upload sau khi dữ liệu cơ bản đã hợp lệ
      if (req.file) {
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        data.thumbnail = { url: uploaded.secure_url, publicId: uploaded.public_id };
      }

      const video = await ReviewVideo.create(data);

      res.status(201).json({ message: "Thêm video thành công", video });
    } catch (error) {
      // Lỗi lưu DB -> xoá ảnh vừa upload để không rác Cloudinary
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // GET /api/review-videos?search=&status=all|active|inactive|expired|scheduled   (admin)
  // Trả về danh sách + số liệu thống kê
  getReviewVideos: async (req, res) => {
    try {
      const { search, status = "all" } = req.query;
      const now = new Date();

      const query = { ...statusFilter(status, now) };

      if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        query.$or = [{ title: regex }, { channelName: regex }];
      }

      const [videos, total, active, inactive, expired, scheduled] = await Promise.all([
        ReviewVideo.find(query).sort({ order: 1, createdAt: -1 }),
        ReviewVideo.countDocuments(),
        ReviewVideo.countDocuments(statusFilter("active", now)),
        ReviewVideo.countDocuments(statusFilter("inactive", now)),
        ReviewVideo.countDocuments(statusFilter("expired", now)),
        ReviewVideo.countDocuments(statusFilter("scheduled", now)),
      ]);

      res.status(200).json({
        videos, // mỗi video có thêm field ảo "status" và "thumbnailUrl"
        stats: { total, active, inactive, expired, scheduled },
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/review-videos/public  (trang chủ, không cần đăng nhập)
  // Chỉ video đang bật, trong thời gian hiển thị, có videoId
  getPublicReviewVideos: async (req, res) => {
    try {
      const videos = await ReviewVideo.findPublic()
        .where("videoId")
        .exists(true)
        .select("videoId title channelName thumbnail order");

      // thumbnailUrl là field ảo, tự có trong JSON
      res.status(200).json({ videos });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/review-videos/:id
  getReviewVideoById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const video = await ReviewVideo.findById(id);
      if (!video) return res.status(404).json({ message: "Không tìm thấy video" });

      res.status(200).json({ video });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PUT /api/review-videos/:id  (multipart/form-data, "thumbnail" tuỳ chọn)
  // Gửi removeThumbnail=true để bỏ ảnh bìa riêng (quay về ảnh mặc định của YouTube)
  updateReviewVideo: async (req, res) => {
    let uploaded = null;
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const video = await ReviewVideo.findById(id);
      if (!video) return res.status(404).json({ message: "Không tìm thấy video" });

      const { youtubeUrl, title, channelName, order, isActive } = req.body;

      // Đổi link -> tách lại mã video, không được trùng video khác
      if (youtubeUrl !== undefined) {
        const videoId = extractYoutubeId(youtubeUrl);
        if (!videoId) return res.status(400).json({ message: "Link YouTube không hợp lệ" });

        if (videoId !== video.videoId) {
          const dup = await ReviewVideo.exists({ videoId, _id: { $ne: id } });
          if (dup) return res.status(409).json({ message: "Video này đã có trong danh sách" });
        }
        video.youtubeUrl = youtubeUrl;
        video.videoId = videoId;
      }

      if (title !== undefined) {
        if (!title.trim()) return res.status(400).json({ message: "Vui lòng nhập tiêu đề video" });
        video.title = title;
      }

      // Chỉ gán field nào client có gửi lên
      if (channelName !== undefined) video.channelName = channelName;
      if (isActive !== undefined) video.isActive = toBool(isActive, video.isActive);
      if (order !== undefined && order !== "") video.order = Number(order);

      const startAt = parseDate(req.body.startAt);
      const endAt = parseDate(req.body.endAt);
      if (startAt === "invalid" || endAt === "invalid") {
        return res.status(400).json({ message: "Thời gian không hợp lệ" });
      }
      if (startAt !== undefined) video.startAt = startAt;
      if (endAt !== undefined) video.endAt = endAt;

      if (video.startAt && video.endAt && video.endAt <= video.startAt) {
        return res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      }

      // Ảnh bìa: thay mới, hoặc bỏ ảnh riêng
      const oldPublicId = video.thumbnail?.publicId;
      if (req.file) {
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        video.thumbnail = { url: uploaded.secure_url, publicId: uploaded.public_id };
      } else if (toBool(req.body.removeThumbnail, false)) {
        video.thumbnail = undefined;
      }

      await video.save();

      // Lưu xong mới xoá ảnh cũ trên Cloudinary
      const thumbnailChanged = !!uploaded || toBool(req.body.removeThumbnail, false);
      if (oldPublicId && thumbnailChanged) {
        await deleteImageFromCloudinary(oldPublicId).catch((e) => console.log(e));
      }

      res.status(200).json({ message: "Cập nhật video thành công", video });
    } catch (error) {
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // PATCH /api/review-videos/:id/toggle  (công tắc Bật/Tắt)
  toggleReviewVideo: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const video = await ReviewVideo.findById(id);
      if (!video) return res.status(404).json({ message: "Không tìm thấy video" });

      video.isActive =
        req.body?.isActive !== undefined
          ? toBool(req.body.isActive, video.isActive)
          : !video.isActive;
      await video.save();

      res.status(200).json({
        message: video.isActive ? "Đã bật video" : "Đã tắt video",
        video,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/review-videos/reorder   (kéo thả)
  //   body: { ids: ["id1", "id2", ...] }  -> phải là TOÀN BỘ video, theo thứ tự mới
  reorderReviewVideos: async (req, res) => {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || !ids.length || !ids.every(isValidId)) {
        return res.status(400).json({ message: "Danh sách ID không hợp lệ" });
      }
      if (new Set(ids.map(String)).size !== ids.length) {
        return res.status(400).json({ message: "Danh sách ID bị trùng" });
      }

      // Phải gửi đủ toàn bộ video, nếu thiếu thì order sẽ bị trùng với video còn lại
      const total = await ReviewVideo.countDocuments();
      if (ids.length !== total) {
        return res
          .status(400)
          .json({ message: "Danh sách thứ tự không đầy đủ, vui lòng tải lại trang" });
      }

      const count = await ReviewVideo.countDocuments({ _id: { $in: ids } });
      if (count !== ids.length) {
        return res.status(400).json({ message: "Có video không tồn tại" });
      }

      await ReviewVideo.bulkWrite(
        ids.map((vid, index) => ({
          updateOne: { filter: { _id: vid }, update: { $set: { order: index + 1 } } },
        }))
      );

      res.status(200).json({ message: "Cập nhật thứ tự thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/review-videos/:id/move   body: { direction: "up" | "down" }  (mũi tên ↑↓)
  moveReviewVideo: async (req, res) => {
    try {
      const { id } = req.params;
      const { direction } = req.body;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });
      if (!["up", "down"].includes(direction)) {
        return res.status(400).json({ message: "Hướng di chuyển không hợp lệ" });
      }

      if (!(await ReviewVideo.exists({ _id: id }))) {
        return res.status(404).json({ message: "Không tìm thấy video" });
      }

      // Chuẩn hoá thứ tự trước để tránh trùng order
      await compactOrders();

      const video = await ReviewVideo.findById(id);

      const neighbor = await ReviewVideo.findOne({
        order: direction === "up" ? { $lt: video.order } : { $gt: video.order },
      }).sort({ order: direction === "up" ? -1 : 1 });

      if (!neighbor) {
        return res.status(400).json({
          message: direction === "up" ? "Video đã ở đầu danh sách" : "Video đã ở cuối danh sách",
        });
      }

      const current = video.order;
      await ReviewVideo.bulkWrite([
        { updateOne: { filter: { _id: video._id }, update: { $set: { order: neighbor.order } } } },
        { updateOne: { filter: { _id: neighbor._id }, update: { $set: { order: current } } } },
      ]);

      res.status(200).json({ message: "Đã đổi thứ tự" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // DELETE /api/review-videos/:id
  deleteReviewVideo: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const video = await ReviewVideo.findById(id);
      if (!video) return res.status(404).json({ message: "Không tìm thấy video" });

      await video.deleteOne();

      // Xoá ảnh bìa riêng trên Cloudinary nếu có
      if (video.thumbnail?.publicId) {
        await deleteImageFromCloudinary(video.thumbnail.publicId).catch((e) => console.log(e));
      }

      await compactOrders();

      res.status(200).json({ message: "Xoá video thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },
};

export default reviewVideoController;