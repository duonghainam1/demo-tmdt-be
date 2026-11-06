import mongoose from "mongoose";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js"; // TODO: chỉnh đường dẫn
import News, { NEWS_CATEGORIES, slugify, publicFilter } from "../../models/news/newsModel.js"; // TODO: chỉnh đường dẫn

const FOLDER = "news";

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

// Nội dung rỗng (chỉ có thẻ trống) mà không có ảnh => coi như chưa nhập
const isEmptyHtml = (html = "") =>
  !/<img/i.test(html) && !String(html).replace(/<[^>]*>|&nbsp;/g, "").trim();

// Chuẩn hoá lỗi: validate của mongoose -> 400, trùng slug -> 409
const handleError = (res, error) => {
  if (error.name === "ValidationError") {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ message: messages[0], errors: messages });
  }
  if (error.code === 11000) {
    return res.status(409).json({ message: "Đường dẫn bài viết đã tồn tại" });
  }
  console.log(error);
  return res.status(500).json({ message: "Lỗi server" });
};

// Điều kiện Mongo cho từng trạng thái
const statusFilter = (status, now = new Date()) => {
  switch (status) {
    case "draft":
      return { isActive: false, hasPublished: { $ne: true } };
    case "hidden":
      return { isActive: false, hasPublished: true };
    case "scheduled":
      return { isActive: true, startAt: { $gt: now } };
    case "expired":
      return { isActive: true, endAt: { $lt: now } };
    case "published":
      return publicFilter(now);
    default:
      return {};
  }
};

// Slug tự tạo từ tiêu đề, trùng thì thêm -2, -3...
const uniqueSlug = async (base, excludeId) => {
  const root = slugify(base) || "bai-viet";
  let slug = root;
  let i = 2;
  const notSelf = excludeId ? { _id: { $ne: excludeId } } : {};
  while (await News.exists({ slug, ...notSelf })) slug = `${root}-${i++}`;
  return slug;
};

// Gộp thứ tự lại 1..n (sau khi xoá / trước khi di chuyển)
const compactOrders = async () => {
  const all = await News.find().sort({ order: 1, createdAt: -1 }).select("_id");
  if (!all.length) return;
  await News.bulkWrite(
    all.map((n, i) => ({
      updateOne: { filter: { _id: n._id }, update: { $set: { order: i + 1 } } },
    }))
  );
};

// Thứ tự kế tiếp (cuối danh sách)
const nextOrder = async () => {
  const last = await News.findOne().sort({ order: -1 }).select("order");
  return last ? last.order + 1 : 1;
};

/* ================= Controller ================= */

const newsController = {
  // POST /api/news  (multipart/form-data, ảnh bìa: field "thumbnail" - tuỳ chọn)
  // body: title, content, slug?, summary?, category?, isActive?, isFeatured?, startAt?, endAt?
  createNews: async (req, res) => {
    let uploaded = null;
    try {
      const { title, slug, summary, category, content, isActive, isFeatured } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ message: "Vui lòng nhập tiêu đề bài viết" });
      }
      if (isEmptyHtml(content)) {
        return res.status(400).json({ message: "Vui lòng nhập nội dung" });
      }
      if (category && !NEWS_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: "Danh mục không hợp lệ" });
      }

      const startAt = parseDate(req.body.startAt);
      const endAt = parseDate(req.body.endAt);
      if (startAt === "invalid" || endAt === "invalid") {
        return res.status(400).json({ message: "Thời gian không hợp lệ" });
      }
      if (startAt && endAt && endAt <= startAt) {
        return res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      }

      // Slug: người dùng nhập thì phải chưa tồn tại, không nhập thì tự tạo từ tiêu đề
      let finalSlug;
      if (slug && slug.trim()) {
        finalSlug = slugify(slug);
        if (!finalSlug) return res.status(400).json({ message: "Đường dẫn không hợp lệ" });
        if (await News.exists({ slug: finalSlug })) {
          return res.status(409).json({ message: "Đường dẫn bài viết đã tồn tại" });
        }
      } else {
        finalSlug = await uniqueSlug(title);
      }

      const active = toBool(isActive, true);
      const data = {
        title,
        slug: finalSlug,
        summary,
        category: category || undefined,
        content,
        order: await nextOrder(),
        isActive: active,
        hasPublished: active, // bật hiển thị ngay lúc tạo -> không còn là bản nháp
        isFeatured: toBool(isFeatured, false),
        startAt: startAt ?? null,
        endAt: endAt ?? null,
      };

      // Ảnh bìa (tuỳ chọn): upload sau khi dữ liệu cơ bản đã hợp lệ
      if (req.file) {
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        data.thumbnail = { url: uploaded.secure_url, publicId: uploaded.public_id };
      }

      const news = await News.create(data);

      res.status(201).json({ message: "Thêm bài viết thành công", news });
    } catch (error) {
      // Lỗi lưu DB -> xoá ảnh vừa upload để không rác Cloudinary
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // GET /api/news?search=&status=all|published|draft|scheduled|hidden|expired&category=   (admin)
  // Danh sách (không kèm nội dung cho nhẹ) + số liệu thống kê
  getNews: async (req, res) => {
    try {
      const { search, status = "all", category } = req.query;
      const now = new Date();

      const query = { ...statusFilter(status, now) };

      if (category && category !== "all") query.category = category;

      if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        query.$or = [{ title: regex }, { summary: regex }];
      }

      const [news, total, published, draft, scheduled, hidden, expired] = await Promise.all([
        News.find(query).select("-content").sort({ order: 1, createdAt: -1 }),
        News.countDocuments(),
        News.countDocuments(statusFilter("published", now)),
        News.countDocuments(statusFilter("draft", now)),
        News.countDocuments(statusFilter("scheduled", now)),
        News.countDocuments(statusFilter("hidden", now)),
        News.countDocuments(statusFilter("expired", now)),
      ]);

      res.status(200).json({
        news, // mỗi bài có thêm field ảo "status" và "thumbnailUrl"
        stats: { total, published, draft, scheduled, hidden, expired },
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/news/public?limit=8   (trang chủ, không cần đăng nhập)
  // Chỉ bài đang bật và trong thời gian hiển thị; nổi bật lên trước
  getPublicNews: async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);

      const news = await News.findPublic()
        .limit(limit)
        .select("title slug summary category thumbnail isFeatured order startAt createdAt");

      res.status(200).json({ news });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/news/public/:slug   (trang chi tiết bài viết, không cần đăng nhập)
  getPublicNewsBySlug: async (req, res) => {
    try {
      const news = await News.findOne({ ...publicFilter(), slug: req.params.slug }).select(
        "-hasPublished -order -isActive"
      );
      if (!news) return res.status(404).json({ message: "Không tìm thấy bài viết" });

      res.status(200).json({ news });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/news/:id   (admin, đủ nội dung để sửa)
  getNewsById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const news = await News.findById(id);
      if (!news) return res.status(404).json({ message: "Không tìm thấy bài viết" });

      res.status(200).json({ news });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PUT /api/news/:id  (multipart/form-data, "thumbnail" tuỳ chọn)
  // Gửi removeThumbnail=true để bỏ ảnh bìa
  updateNews: async (req, res) => {
    let uploaded = null;
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const news = await News.findById(id);
      if (!news) return res.status(404).json({ message: "Không tìm thấy bài viết" });

      const { title, slug, summary, category, content, isActive, isFeatured } = req.body;

      if (title !== undefined) {
        if (!title.trim()) return res.status(400).json({ message: "Vui lòng nhập tiêu đề bài viết" });
        news.title = title;
      }

      if (content !== undefined) {
        if (isEmptyHtml(content)) return res.status(400).json({ message: "Vui lòng nhập nội dung" });
        news.content = content;
      }

      // Đổi slug: phải chưa dùng bởi bài khác. Gửi rỗng thì giữ nguyên slug cũ
      if (slug !== undefined && slug.trim()) {
        const newSlug = slugify(slug);
        if (!newSlug) return res.status(400).json({ message: "Đường dẫn không hợp lệ" });
        if (newSlug !== news.slug) {
          if (await News.exists({ slug: newSlug, _id: { $ne: id } })) {
            return res.status(409).json({ message: "Đường dẫn bài viết đã tồn tại" });
          }
          news.slug = newSlug;
        }
      }

      // Chỉ gán field nào client có gửi lên
      if (summary !== undefined) news.summary = summary;
      if (category !== undefined) {
        if (category && !NEWS_CATEGORIES.includes(category)) {
          return res.status(400).json({ message: "Danh mục không hợp lệ" });
        }
        news.category = category || undefined;
      }
      if (isFeatured !== undefined) news.isFeatured = toBool(isFeatured, news.isFeatured);
      if (isActive !== undefined) {
        news.isActive = toBool(isActive, news.isActive);
        if (news.isActive) news.hasPublished = true;
      }

      const startAt = parseDate(req.body.startAt);
      const endAt = parseDate(req.body.endAt);
      if (startAt === "invalid" || endAt === "invalid") {
        return res.status(400).json({ message: "Thời gian không hợp lệ" });
      }
      if (startAt !== undefined) news.startAt = startAt;
      if (endAt !== undefined) news.endAt = endAt;

      if (news.startAt && news.endAt && news.endAt <= news.startAt) {
        return res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      }

      // Ảnh bìa: thay mới, hoặc bỏ ảnh
      const oldPublicId = news.thumbnail?.publicId;
      const removeThumbnail = toBool(req.body.removeThumbnail, false);
      if (req.file) {
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        news.thumbnail = { url: uploaded.secure_url, publicId: uploaded.public_id };
      } else if (removeThumbnail) {
        news.thumbnail = undefined;
      }

      await news.save();

      // Lưu xong mới xoá ảnh cũ trên Cloudinary
      if (oldPublicId && (uploaded || removeThumbnail)) {
        await deleteImageFromCloudinary(oldPublicId).catch((e) => console.log(e));
      }

      res.status(200).json({ message: "Cập nhật bài viết thành công", news });
    } catch (error) {
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // PATCH /api/news/:id/toggle  body: { isActive? }  (công tắc Bật/Tắt)
  toggleNews: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const news = await News.findById(id);
      if (!news) return res.status(404).json({ message: "Không tìm thấy bài viết" });

      news.isActive =
        req.body?.isActive !== undefined ? toBool(req.body.isActive, news.isActive) : !news.isActive;
      if (news.isActive) news.hasPublished = true;
      await news.save();

      res.status(200).json({
        message: news.isActive ? "Đã bật bài viết" : "Đã tắt bài viết",
        news,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/news/reorder   (kéo thả)
  //   body: { ids: ["id1", "id2", ...] }
  reorderNews: async (req, res) => {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || !ids.length || !ids.every(isValidId)) {
        return res.status(400).json({ message: "Danh sách ID không hợp lệ" });
      }

      const count = await News.countDocuments({ _id: { $in: ids } });
      if (count !== ids.length) {
        return res.status(400).json({ message: "Có bài viết không tồn tại" });
      }

      await News.bulkWrite(
        ids.map((nid, index) => ({
          updateOne: { filter: { _id: nid }, update: { $set: { order: index + 1 } } },
        }))
      );

      res.status(200).json({ message: "Cập nhật thứ tự thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/news/:id/move   body: { direction: "up" | "down" }  (mũi tên ↑↓)
  moveNews: async (req, res) => {
    try {
      const { id } = req.params;
      const { direction } = req.body;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });
      if (!["up", "down"].includes(direction)) {
        return res.status(400).json({ message: "Hướng di chuyển không hợp lệ" });
      }

      if (!(await News.exists({ _id: id }))) {
        return res.status(404).json({ message: "Không tìm thấy bài viết" });
      }

      // Chuẩn hoá thứ tự trước để tránh trùng order
      await compactOrders();

      const news = await News.findById(id);

      const neighbor = await News.findOne({
        order: direction === "up" ? { $lt: news.order } : { $gt: news.order },
      }).sort({ order: direction === "up" ? -1 : 1 });

      if (!neighbor) {
        return res.status(400).json({
          message: direction === "up" ? "Bài viết đã ở đầu danh sách" : "Bài viết đã ở cuối danh sách",
        });
      }

      const current = news.order;
      await News.bulkWrite([
        { updateOne: { filter: { _id: news._id }, update: { $set: { order: neighbor.order } } } },
        { updateOne: { filter: { _id: neighbor._id }, update: { $set: { order: current } } } },
      ]);

      res.status(200).json({ message: "Đã đổi thứ tự" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // DELETE /api/news/:id
  deleteNews: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const news = await News.findById(id);
      if (!news) return res.status(404).json({ message: "Không tìm thấy bài viết" });

      await news.deleteOne();

      // Xoá ảnh bìa trên Cloudinary nếu có
      if (news.thumbnail?.publicId) {
        await deleteImageFromCloudinary(news.thumbnail.publicId).catch((e) => console.log(e));
      }

      await compactOrders();

      res.status(200).json({ message: "Xoá bài viết thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },
};

export default newsController;