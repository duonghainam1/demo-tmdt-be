import mongoose from "mongoose";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js";
import Banner, { BANNER_TYPES } from "../../models/banner/bannerModel.js";

const FOLDER = "banners";

// Giới hạn cỡ chữ (px) của banner top dạng chữ
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 40;

/* ================= Helpers ================= */

// "true"/"false" (multipart/form-data gửi chuỗi) -> boolean
const toBool = (v, fallback) => {
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
};

// "" / null -> null, chuỗi ngày -> Date, sai định dạng -> "invalid"
const parseDate = (v) => {
  if (v === undefined) return undefined; // không gửi -> giữ nguyên
  if (v === null || v === "" || v === "null") return null; // xoá lịch
  const d = new Date(v);
  return isNaN(d.getTime()) ? "invalid" : d;
};

// undefined / "" -> undefined (không gửi, giữ nguyên), số nguyên 10-40 -> số, còn lại -> "invalid"
const parseFontSize = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX ? n : "invalid";
};

const FONT_SIZE_ERROR = `Cỡ chữ phải là số nguyên từ ${FONT_SIZE_MIN} đến ${FONT_SIZE_MAX}`;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isValidType = (t) => BANNER_TYPES.includes(t);

const isValidColor = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);

// Danh mục có tồn tại không. Model Category được đăng ký ở nơi khác trong app,
// nếu chưa đăng ký thì bỏ qua bước kiểm tra này.
const categoryExists = async (id) => {
  const Category = mongoose.models.Category;
  return Category ? !!(await Category.exists({ _id: id })) : true;
};

// Chuẩn hoá lỗi validate của mongoose -> 400
const handleError = (res, error) => {
  if (error.name === "ValidationError") {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ message: messages[0], errors: messages });
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

// "Nhóm" để đánh thứ tự: cùng type; riêng banner danh mục thì cùng type + cùng danh mục
const scopeOf = (type, category) =>
  type === "category" ? { type, category } : { type };

// Gộp thứ tự lại 1..n trong MỘT nhóm banner (sau khi xoá / trước khi di chuyển)
const compactOrders = async (scope) => {
  const all = await Banner.find(scope).sort({ order: 1, createdAt: -1 }).select("_id");
  if (!all.length) return;
  await Banner.bulkWrite(
    all.map((b, i) => ({
      updateOne: { filter: { _id: b._id }, update: { $set: { order: i + 1 } } },
    }))
  );
};

// Thứ tự kế tiếp (cuối danh sách) của một nhóm banner
const nextOrder = async (scope) => {
  const last = await Banner.findOne(scope).sort({ order: -1 }).select("order");
  return last ? last.order + 1 : 1;
};

// Kiểm tra các field màu (nếu có gửi)
const validateColors = ({ textColor, backgroundColor }) => {
  if (textColor && !isValidColor(textColor)) return "Màu chữ không hợp lệ (vd: #FFFFFF)";
  if (backgroundColor && !isValidColor(backgroundColor)) return "Màu nền không hợp lệ (vd: #E53935)";
  return null;
};

const POPULATE_CATEGORY = { path: "category", select: "name slug" };

/* ================= Controller ================= */

const bannerController = {
  // POST /api/banners  (multipart/form-data, field ảnh: "image")
  // - top: contentType = "text" | "image"
  // - main / small / category: luôn là ảnh
  // - category: bắt buộc gửi thêm "category" (ID danh mục)
  // - top dạng chữ: có thể gửi thêm "fontSize" (10-40, mặc định 16)
  createBanner: async (req, res) => {
    let uploaded = null;
    try {
      const {
        type,
        category,
        text,
        textColor,
        backgroundColor,
        isMarquee,
        alt,
        link,
        order,
        isActive,
      } = req.body;

      if (!isValidType(type)) {
        return res.status(400).json({ message: "Loại banner không hợp lệ" });
      }

      // Banner theo danh mục: phải có danh mục hợp lệ và tồn tại
      if (type === "category") {
        if (!category || !isValidId(category)) {
          return res.status(400).json({ message: "Vui lòng chọn danh mục cho banner" });
        }
        if (!(await categoryExists(category))) {
          return res.status(404).json({ message: "Không tìm thấy danh mục" });
        }
      }

      // top lấy theo client (mặc định ảnh); các loại còn lại luôn là ảnh
      const contentType = type === "top" && req.body.contentType === "text" ? "text" : "image";

      if (contentType === "image" && !req.file) {
        return res.status(400).json({ message: "Vui lòng tải ảnh banner" });
      }
      if (contentType === "text" && (!text || !text.trim())) {
        return res.status(400).json({ message: "Vui lòng nhập nội dung chữ cho banner top" });
      }

      const colorError = validateColors({ textColor, backgroundColor });
      if (colorError) return res.status(400).json({ message: colorError });

      const fontSize = parseFontSize(req.body.fontSize);
      if (fontSize === "invalid") {
        return res.status(400).json({ message: FONT_SIZE_ERROR });
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
        type,
        contentType,
        link,
        alt,
        order:
          order !== undefined && order !== ""
            ? Number(order)
            : await nextOrder(scopeOf(type, category)),
        isActive: toBool(isActive, true),
        startAt: startAt ?? null,
        endAt: endAt ?? null,
      };

      if (type === "category") data.category = category;

      if (contentType === "image") {
        // Upload ảnh sau khi dữ liệu cơ bản hợp lệ
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        data.image = { url: uploaded.secure_url, publicId: uploaded.public_id };
      } else {
        data.text = text;
        if (textColor) data.textColor = textColor;
        if (backgroundColor) data.backgroundColor = backgroundColor;
        if (fontSize !== undefined) data.fontSize = fontSize;
        data.isMarquee = toBool(isMarquee, true);
      }

      const banner = await Banner.create(data);
      await banner.populate(POPULATE_CATEGORY);

      res.status(201).json({ message: "Tạo banner thành công", banner });
    } catch (error) {
      // Lỗi lưu DB -> xoá ảnh vừa upload để không rác Cloudinary
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // GET /api/banners?type=top|main|small|category&category=<id>&search=&status=all|active|inactive|expired|scheduled
  // Trả về danh sách (admin) + số liệu thống kê (theo bộ lọc type/category đang chọn)
  getBanners: async (req, res) => {
    try {
      const { search, status = "all", type, category } = req.query;
      const now = new Date();

      if (type && !isValidType(type)) {
        return res.status(400).json({ message: "Loại banner không hợp lệ" });
      }
      if (category && !isValidId(category)) {
        return res.status(400).json({ message: "ID danh mục không hợp lệ" });
      }

      const base = {};
      if (type) base.type = type;
      if (category) base.category = category;
      const query = { ...base, ...statusFilter(status, now) };

      if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
        query.$or = [{ text: regex }, { alt: regex }];
      }

      const [banners, total, active, inactive, expired, scheduled, byType] = await Promise.all([
        Banner.find(query)
          .populate(POPULATE_CATEGORY)
          .sort({ type: 1, category: 1, order: 1, createdAt: -1 }),
        Banner.countDocuments(base),
        Banner.countDocuments({ ...base, ...statusFilter("active", now) }),
        Banner.countDocuments({ ...base, ...statusFilter("inactive", now) }),
        Banner.countDocuments({ ...base, ...statusFilter("expired", now) }),
        Banner.countDocuments({ ...base, ...statusFilter("scheduled", now) }),
        Banner.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }]),
      ]);

      res.status(200).json({
        banners, // mỗi banner có thêm field ảo "status"; banner danh mục có category: { _id, name, slug }
        stats: {
          total,
          active,
          inactive,
          expired,
          scheduled,
          byType: BANNER_TYPES.reduce(
            (acc, t) => ({ ...acc, [t]: byType.find((x) => x._id === t)?.count || 0 }),
            {}
          ),
        },
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/banners/public  (trang chủ, không cần đăng nhập)
  //  - ?type=top|main|small            -> { banners: [...] }
  //  - ?type=category&category=<id>    -> { banners: [...] } của 1 danh mục
  //  - ?type=category                  -> { banners: [...] } của mọi danh mục
  //  - không truyền type -> trả về nhóm sẵn:
  //      { top: [], main: [], small: [], category: { "<categoryId>": [banner, ...] } }
  getPublicBanners: async (req, res) => {
    try {
      const { type, category } = req.query;

      if (type) {
        if (!isValidType(type)) {
          return res.status(400).json({ message: "Loại banner không hợp lệ" });
        }
        if (category && !isValidId(category)) {
          return res.status(400).json({ message: "ID danh mục không hợp lệ" });
        }
        const banners = await Banner.findPublic(
          type,
          type === "category" ? category : undefined
        ).select("-createdAt -updatedAt -__v");
        return res.status(200).json({ banners });
      }

      const all = await Banner.findPublic().select("-createdAt -updatedAt -__v");

      const grouped = { top: [], main: [], small: [], category: {} };
      all.forEach((b) => {
        if (b.type === "category") {
          if (!b.category) return; // banner danh mục lỗi dữ liệu thì bỏ qua
          const key = String(b.category);
          (grouped.category[key] ||= []).push(b);
        } else if (Array.isArray(grouped[b.type])) {
          // Bỏ qua banner cũ chưa có type hợp lệ để không làm sập API
          grouped[b.type].push(b);
        }
      });

      res.status(200).json(grouped);
    } catch (error) {
      handleError(res, error);
    }
  },

  // GET /api/banners/:id
  getBannerById: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const banner = await Banner.findById(id).populate(POPULATE_CATEGORY);
      if (!banner) return res.status(404).json({ message: "Không tìm thấy banner" });

      res.status(200).json({ banner });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PUT /api/banners/:id  (multipart/form-data, "image" tuỳ chọn)
  // Không cho đổi "type" sau khi tạo. Banner danh mục thì được đổi sang danh mục khác.
  updateBanner: async (req, res) => {
    let uploaded = null;
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const banner = await Banner.findById(id);
      if (!banner) return res.status(404).json({ message: "Không tìm thấy banner" });

      const { type, category, text, textColor, backgroundColor, isMarquee, alt, link, order, isActive } =
        req.body;

      if (type !== undefined && type !== banner.type) {
        return res.status(400).json({ message: "Không thể đổi loại banner sau khi tạo" });
      }

      const colorError = validateColors({ textColor, backgroundColor });
      if (colorError) return res.status(400).json({ message: colorError });

      const fontSize = parseFontSize(req.body.fontSize);
      if (fontSize === "invalid") {
        return res.status(400).json({ message: FONT_SIZE_ERROR });
      }

      // Đổi danh mục (chỉ với banner danh mục)
      const oldCategory = banner.category;
      let categoryChanged = false;
      if (
        banner.type === "category" &&
        category !== undefined &&
        String(category) !== String(oldCategory)
      ) {
        if (!category || !isValidId(category)) {
          return res.status(400).json({ message: "Vui lòng chọn danh mục cho banner" });
        }
        if (!(await categoryExists(category))) {
          return res.status(404).json({ message: "Không tìm thấy danh mục" });
        }
        banner.category = category;
        categoryChanged = true;
      }

      // Xác định kiểu nội dung sau khi cập nhật (main/small/category luôn là ảnh)
      let contentType = banner.contentType;
      if (banner.type === "top" && req.body.contentType !== undefined) {
        contentType = req.body.contentType === "text" ? "text" : "image";
      }
      if (banner.type !== "top") contentType = "image";

      const oldPublicId = banner.image?.publicId;
      const hasOldImage = !!banner.image?.url;

      if (contentType === "image" && !req.file && !hasOldImage) {
        return res.status(400).json({ message: "Vui lòng tải ảnh banner" });
      }
      if (contentType === "text") {
        const nextText = text !== undefined ? text : banner.text;
        if (!nextText || !nextText.trim()) {
          return res.status(400).json({ message: "Vui lòng nhập nội dung chữ cho banner top" });
        }
      }

      // Chỉ gán field nào client có gửi lên
      banner.contentType = contentType;
      if (text !== undefined) banner.text = text;
      if (textColor !== undefined) banner.textColor = textColor;
      if (backgroundColor !== undefined) banner.backgroundColor = backgroundColor;
      if (fontSize !== undefined) banner.fontSize = fontSize;
      if (isMarquee !== undefined) banner.isMarquee = toBool(isMarquee, banner.isMarquee);
      if (alt !== undefined) banner.alt = alt;
      if (link !== undefined) banner.link = link;
      if (isActive !== undefined) banner.isActive = toBool(isActive, banner.isActive);

      if (order !== undefined && order !== "") {
        banner.order = Number(order);
      } else if (categoryChanged) {
        // Chuyển sang danh mục khác mà không chỉ định thứ tự -> xếp xuống cuối nhóm mới
        banner.order = await nextOrder(scopeOf("category", banner.category));
      }

      const startAt = parseDate(req.body.startAt);
      const endAt = parseDate(req.body.endAt);
      if (startAt === "invalid" || endAt === "invalid") {
        return res.status(400).json({ message: "Thời gian không hợp lệ" });
      }
      if (startAt !== undefined) banner.startAt = startAt;
      if (endAt !== undefined) banner.endAt = endAt;

      if (banner.startAt && banner.endAt && banner.endAt <= banner.startAt) {
        return res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      }

      // Đổi ảnh: upload ảnh mới, lưu xong mới xoá ảnh cũ
      if (contentType === "image" && req.file) {
        uploaded = await uploadImageToCloudinary(req.file.buffer, FOLDER);
        banner.image = { url: uploaded.secure_url, publicId: uploaded.public_id };
      }

      // Model (pre-validate) tự xoá field image khi contentType = "text" và dọn text khi là ảnh
      await banner.save(); // chạy validator trên document

      // Banner rời nhóm danh mục cũ -> gộp lại thứ tự nhóm cũ
      if (categoryChanged && oldCategory) {
        await compactOrders(scopeOf("category", oldCategory)).catch((e) => console.log(e));
      }

      // Xoá ảnh cũ trên Cloudinary khi: đã thay ảnh mới, hoặc chuyển top từ ảnh sang chữ
      const imageReplaced = !!uploaded;
      const switchedToText = contentType === "text" && hasOldImage;
      if (oldPublicId && (imageReplaced || switchedToText)) {
        await deleteImageFromCloudinary(oldPublicId).catch((e) => console.log(e));
      }

      await banner.populate(POPULATE_CATEGORY);

      res.status(200).json({ message: "Cập nhật banner thành công", banner });
    } catch (error) {
      if (uploaded?.public_id) {
        await deleteImageFromCloudinary(uploaded.public_id).catch(() => {});
      }
      handleError(res, error);
    }
  },

  // PATCH /api/banners/:id/toggle  (công tắc Bật/Tắt)
  toggleBanner: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const banner = await Banner.findById(id);
      if (!banner) return res.status(404).json({ message: "Không tìm thấy banner" });

      banner.isActive =
        req.body?.isActive !== undefined
          ? toBool(req.body.isActive, banner.isActive)
          : !banner.isActive;
      await banner.save();

      res.status(200).json({
        message: banner.isActive ? "Đã bật banner" : "Đã tắt banner",
        banner,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/banners/reorder   (kéo thả)
  //   body: { type: "main", ids: ["id1","id2",...] }
  //   body: { type: "category", category: "<categoryId>", ids: [...] }  <- banner danh mục: bắt buộc có category
  // Chỉ sắp xếp trong cùng một nhóm banner
  reorderBanners: async (req, res) => {
    try {
      const { type, category, ids } = req.body;

      if (!isValidType(type)) {
        return res.status(400).json({ message: "Loại banner không hợp lệ" });
      }
      if (type === "category" && (!category || !isValidId(category))) {
        return res.status(400).json({ message: "Vui lòng chọn danh mục để sắp xếp banner" });
      }
      if (!Array.isArray(ids) || !ids.length || !ids.every(isValidId)) {
        return res.status(400).json({ message: "Danh sách ID không hợp lệ" });
      }

      const scope = scopeOf(type, category);

      // Đảm bảo tất cả ID đều thuộc nhóm này
      const count = await Banner.countDocuments({ _id: { $in: ids }, ...scope });
      if (count !== ids.length) {
        return res.status(400).json({ message: "Có banner không thuộc nhóm đã chọn" });
      }

      await Banner.bulkWrite(
        ids.map((id, index) => ({
          updateOne: { filter: { _id: id, ...scope }, update: { $set: { order: index + 1 } } },
        }))
      );

      res.status(200).json({ message: "Cập nhật thứ tự thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // PATCH /api/banners/:id/move   body: { direction: "up" | "down" }  (mũi tên ↑↓)
  // Chỉ đổi chỗ với banner cùng nhóm (cùng type, và cùng danh mục với banner danh mục)
  moveBanner: async (req, res) => {
    try {
      const { id } = req.params;
      const { direction } = req.body;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });
      if (!["up", "down"].includes(direction)) {
        return res.status(400).json({ message: "Hướng di chuyển không hợp lệ" });
      }

      const found = await Banner.findById(id).select("type category");
      if (!found) return res.status(404).json({ message: "Không tìm thấy banner" });

      const scope = scopeOf(found.type, found.category);

      // Chuẩn hoá thứ tự trong nhóm này trước để tránh trùng order
      await compactOrders(scope);

      const banner = await Banner.findById(id);

      const neighbor = await Banner.findOne({
        ...scope,
        order: direction === "up" ? { $lt: banner.order } : { $gt: banner.order },
      }).sort({ order: direction === "up" ? -1 : 1 });

      if (!neighbor) {
        return res.status(400).json({
          message: direction === "up" ? "Banner đã ở đầu danh sách" : "Banner đã ở cuối danh sách",
        });
      }

      const current = banner.order;
      await Banner.bulkWrite([
        { updateOne: { filter: { _id: banner._id }, update: { $set: { order: neighbor.order } } } },
        { updateOne: { filter: { _id: neighbor._id }, update: { $set: { order: current } } } },
      ]);

      res.status(200).json({ message: "Đã đổi thứ tự" });
    } catch (error) {
      handleError(res, error);
    }
  },

  // DELETE /api/banners/:id
  deleteBanner: async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

      const banner = await Banner.findById(id);
      if (!banner) return res.status(404).json({ message: "Không tìm thấy banner" });

      await banner.deleteOne();

      // Xoá ảnh trên Cloudinary nếu có (banner top dạng chữ không có ảnh)
      if (banner.image?.publicId) {
        await deleteImageFromCloudinary(banner.image.publicId).catch((e) => console.log(e));
      }

      await compactOrders(scopeOf(banner.type, banner.category));

      res.status(200).json({ message: "Xoá banner thành công" });
    } catch (error) {
      handleError(res, error);
    }
  },
};

export default bannerController;