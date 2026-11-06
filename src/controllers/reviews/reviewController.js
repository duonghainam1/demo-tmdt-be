import mongoose from 'mongoose';
import Reviews from '../../models/review/reviewModel.js';
import { uploadImageToCloudinary, deleteImageFromCloudinary } from '../../utils/uploadCloudinary.js'; // chỉnh đường dẫn
const Users = () => mongoose.model('Users');
const Products = () => mongoose.model('Products');
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Model Orders lấy qua mongoose.model() để khỏi phụ thuộc đường dẫn import.
 * (model 'Orders' đã được đăng ký khi app khởi động)
 */
const Orders = () => mongoose.model('Orders');

const CLOUDINARY_FOLDER = 'reviews';
const MAX_IMAGES = 5; // ảnh / đánh giá
const MAX_COMMENT = 1000;
const MAX_REPLY = 500;
const EDIT_WINDOW_DAYS = 30;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/* ================================================================== */
/* Tiện ích                                                            */
/* ================================================================== */

const toId = (v) => new mongoose.Types.ObjectId(String(v));

const parseRating = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

/** { [key]: File[] } từ các field "images_<key>" */
const groupFilesByKey = (files = []) => {
  const map = {};
  for (const f of files) {
    const m = /^images_(.+)$/.exec(f.fieldname);
    if (!m) continue;
    (map[m[1]] ||= []).push(f);
  }
  return map;
};

/** UI gửi key = id dòng hàng trong đơn; chấp nhận cả id biến thể cho chắc */
const findOrderItem = (order, key) =>
  order.items.find((i) => String(i._id) === String(key) || String(i.variant) === String(key));

/** Chỉ cho JPG / PNG / WEBP (uploadMiddleware đang cho mọi image/*, bao gồm cả svg) */
const hasInvalidImageType = (files) => files.some((f) => !ALLOWED_IMAGE_TYPES.includes(f.mimetype));

/**
 * Tìm đơn của khách theo ObjectId HOẶC mã đơn (code, vd NX2610043XPXJ0).
 * Luôn ràng buộc user để khách không đụng được đơn của người khác.
 */
const findMyOrder = (ref, userId) => {
  const cond = mongoose.isValidObjectId(ref) ? { _id: ref } : { code: String(ref) };
  return Orders().findOne({ ...cond, user: userId });
};

/**
 * Upload nhiều ảnh. Nếu có ảnh lỗi thì xoá luôn các ảnh đã lên rồi ném lỗi,
 * để không bị ảnh mồ côi trên Cloudinary.
 */
const uploadAll = async (files) => {
  const settled = await Promise.allSettled(files.map((f) => uploadImageToCloudinary(f.buffer, CLOUDINARY_FOLDER)));
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length !== files.length) {
    await Promise.allSettled(ok.map((r) => deleteImageFromCloudinary(r.public_id)));
    throw new Error('UPLOAD_FAILED');
  }
  return ok.map((r) => ({ url: r.secure_url, publicId: r.public_id }));
};

const cleanupImages = (images = []) =>
  Promise.allSettled(images.map((i) => deleteImageFromCloudinary(i.publicId)));

/* ================================================================== */
/* CÔNG KHAI                                                           */
/* ================================================================== */

/**
 * GET /products/:productId/reviews?page=1&limit=10&rating=5&hasImages=true
 * -> { data, total, page, limit, breakdown: {1..5} }
 */
export const getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ message: 'Mã sản phẩm không hợp lệ' });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

    const filter = { product: productId, status: 'visible' };
    if (req.query.rating) filter.rating = Number(req.query.rating);
    if (req.query.hasImages === 'true') filter['images.0'] = { $exists: true };

    const [items, total, stats] = await Promise.all([
      Reviews.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'fullName name avatar') // chỉnh theo field của model Users
        .select('-status')
        .lean(),
      Reviews.countDocuments(filter),
      Reviews.aggregate([
        { $match: { product: toId(productId), status: 'visible' } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]),
    ]);

    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    stats.forEach((s) => (breakdown[s._id] = s.count));

    res.json({ data: items, total, page, limit, breakdown });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/* ================================================================== */
/* KHÁCH HÀNG                                                          */
/* ================================================================== */

/**
 * GET /reviews/order/:orderId     (orderId = ObjectId hoặc mã đơn)
 * Các đánh giá khách đã gửi trong 1 đơn -> để popup biết món nào "đã đánh giá".
 * Mỗi đánh giá có thêm `key` = id dòng hàng trong đơn (khớp với items[].key bên FE).
 */
export const getOrderReviews = async (req, res) => {
  try {
    const order = await findMyOrder(req.params.orderId, req.user._id).select('_id items').lean();
    if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

    const reviews = await Reviews.find({ user: req.user._id, order: order._id })
      .select('variant rating comment images createdAt editedAt')
      .lean();

    const keyByVariant = new Map(order.items.map((i) => [String(i.variant), String(i._id)]));
    const data = reviews.map((r) => ({ ...r, key: keyByVariant.get(String(r.variant)) ?? null }));

    res.json({ data });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * GET /reviews/pending
 * Các món trong đơn "completed" của khách mà chưa đánh giá.
 */
export const getPendingReviews = async (req, res) => {
  try {
    const orders = await Orders()
      .find({ user: req.user._id, status: 'completed' })
      .sort({ createdAt: -1 })
      .select('code items createdAt')
      .lean();

    const reviewed = await Reviews.find({
      user: req.user._id,
      order: { $in: orders.map((o) => o._id) },
    })
      .select('order variant')
      .lean();
    const done = new Set(reviewed.map((r) => `${r.order}_${r.variant}`));

    const pending = [];
    for (const o of orders) {
      for (const it of o.items) {
        if (done.has(`${o._id}_${it.variant}`)) continue;
        pending.push({
          orderId: o._id,
          orderCode: o.code,
          itemId: it._id,
          product: it.product,
          variant: it.variant,
          name: it.name,
          image: it.image,
          attributes: it.attributes,
        });
      }
    }
    res.json({ data: pending });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/**
 * POST /orders/:orderId/reviews        (multipart/form-data; orderId = ObjectId hoặc mã đơn)
 *   payload      : JSON string  { reviews: [{ key, rating, comment }] }
 *   images_<key> : file ảnh của món có id = key (tối đa 5 ảnh / món)
 *
 * Trả về { data: [{ key, status: 'created' | 'skipped' | 'failed', message? }] }
 */
export const createOrderReviews = async (req, res) => {
  try {
    let payload;
    try {
      payload = JSON.parse(req.body.payload || '{}');
    } catch {
      return res.status(400).json({ message: 'Dữ liệu đánh giá không hợp lệ' });
    }
    const incoming = Array.isArray(payload.reviews) ? payload.reviews : [];
    if (incoming.length === 0) {
      return res.status(400).json({ message: 'Chưa có đánh giá nào để gửi' });
    }

    // Đơn phải của chính khách và đã hoàn thành
    const order = await findMyOrder(req.params.orderId, req.user._id);
    if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    if (order.status !== 'completed') {
      return res.status(400).json({ message: 'Chỉ đánh giá được khi đơn hàng đã hoàn thành' });
    }

    const filesByKey = groupFilesByKey(req.files);

    /* ---- 1. Kiểm tra hết trước khi upload bất cứ ảnh nào ---- */
    const errors = {};
    const tasks = [];
    const seen = new Set();

    for (const r of incoming) {
      const key = String(r.key);
      const item = findOrderItem(order, key);
      const rating = parseRating(r.rating);
      const comment = String(r.comment ?? '').trim();
      const files = filesByKey[key] || [];

      if (!item) errors[key] = 'Sản phẩm không thuộc đơn hàng này';
      else if (seen.has(String(item.variant))) errors[key] = 'Sản phẩm bị gửi trùng';
      else if (!rating) errors[key] = 'Số sao phải từ 1 đến 5';
      else if (comment.length > MAX_COMMENT) errors[key] = `Nhận xét tối đa ${MAX_COMMENT} ký tự`;
      else if (files.length > MAX_IMAGES) errors[key] = `Tối đa ${MAX_IMAGES} ảnh`;
      else if (hasInvalidImageType(files)) errors[key] = 'Chỉ nhận ảnh JPG, PNG hoặc WEBP';
      else {
        seen.add(String(item.variant));
        tasks.push({ key, item, rating, comment, files });
      }
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Dữ liệu đánh giá không hợp lệ', errors });
    }

    // Món đã đánh giá từ trước thì bỏ qua (không coi là lỗi, để khách gửi lại được)
    const existing = await Reviews.find({
      order: order._id,
      variant: { $in: tasks.map((t) => t.item.variant) },
    })
      .select('variant')
      .lean();
    const reviewedVariants = new Set(existing.map((e) => String(e.variant)));

    /* ---- 2. Upload ảnh + lưu từng đánh giá ---- */
    const results = [];
    for (const t of tasks) {
      if (reviewedVariants.has(String(t.item.variant))) {
        results.push({ key: t.key, status: 'skipped', message: 'Đã đánh giá trước đó' });
        continue;
      }

      let images = [];
      try {
        images = await uploadAll(t.files);
        const review = await Reviews.create({
          user: req.user._id,
          product: t.item.product,
          variant: t.item.variant,
          order: order._id,
          variantAttributes: (t.item.attributes || []).map((a) => ({ name: a.name, value: a.value })),
          rating: t.rating,
          comment: t.comment,
          images,
        });
        results.push({ key: t.key, status: 'created', reviewId: review._id });
      } catch (e) {
        await cleanupImages(images); // lưu DB lỗi -> xoá ảnh vừa upload
        if (e.code === 11000) {
          results.push({ key: t.key, status: 'skipped', message: 'Đã đánh giá trước đó' });
        } else {
          results.push({
            key: t.key,
            status: 'failed',
            message: e.message === 'UPLOAD_FAILED' ? 'Tải ảnh thất bại' : 'Gửi đánh giá thất bại',
          });
        }
      }
    }

    /* ---- 3. Cập nhật điểm sao cho từng sản phẩm vừa có đánh giá mới ---- */
    const createdProducts = new Set(
      tasks
        .filter((t) => results.find((r) => r.key === t.key)?.status === 'created')
        .map((t) => String(t.item.product))
    );
    await Promise.all([...createdProducts].map((id) => Reviews.recalcProductRating(id)));

    const allFailed = results.every((r) => r.status === 'failed');
    return res.status(allFailed ? 500 : 201).json({ data: results });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

/**
 * PUT /reviews/:id        (multipart/form-data; sửa 1 lần, trong 30 ngày)
 *   rating, comment
 *   keepImages : JSON string mảng publicId ảnh cũ muốn GIỮ lại
 *   images     : file ảnh MỚI
 */
export const updateReview = async (req, res) => {
  let newImages = [];
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Mã đánh giá không hợp lệ' });
    }
    const review = await Reviews.findOne({ _id: req.params.id, user: req.user._id });
    if (!review) return res.status(404).json({ message: 'Không tìm thấy đánh giá' });
    if (review.editedAt) return res.status(400).json({ message: 'Đánh giá chỉ được sửa 1 lần' });
    if ((Date.now() - review.createdAt.getTime()) / 86400000 > EDIT_WINDOW_DAYS) {
      return res.status(400).json({ message: `Chỉ sửa được trong ${EDIT_WINDOW_DAYS} ngày` });
    }

    if (req.body.rating !== undefined) {
      const rating = parseRating(req.body.rating);
      if (!rating) return res.status(400).json({ message: 'Số sao phải từ 1 đến 5' });
      review.rating = rating;
    }
    if (req.body.comment !== undefined) {
      const comment = String(req.body.comment).trim();
      if (comment.length > MAX_COMMENT) {
        return res.status(400).json({ message: `Nhận xét tối đa ${MAX_COMMENT} ký tự` });
      }
      review.comment = comment;
    }

    // Ảnh: giữ một số ảnh cũ + thêm ảnh mới
    let keep = review.images.map((i) => i.publicId);
    if (req.body.keepImages !== undefined) {
      try {
        keep = JSON.parse(req.body.keepImages);
        if (!Array.isArray(keep)) throw new Error();
      } catch {
        return res.status(400).json({ message: 'Danh sách ảnh giữ lại không hợp lệ' });
      }
    }
    const kept = review.images.filter((i) => keep.includes(i.publicId));
    const removed = review.images.filter((i) => !keep.includes(i.publicId));
    const newFiles = (req.files || []).filter((f) => f.fieldname === 'images');

    if (hasInvalidImageType(newFiles)) {
      return res.status(400).json({ message: 'Chỉ nhận ảnh JPG, PNG hoặc WEBP' });
    }
    if (kept.length + newFiles.length > MAX_IMAGES) {
      return res.status(400).json({ message: `Tối đa ${MAX_IMAGES} ảnh` });
    }

    newImages = await uploadAll(newFiles);
    review.images = [...kept, ...newImages];
    review.editedAt = new Date();
    await review.save();

    await cleanupImages(removed); // chỉ xoá ảnh cũ sau khi lưu DB thành công
    await Reviews.recalcProductRating(review.product);
    return res.json({ data: review });
  } catch (e) {
    await cleanupImages(newImages);
    return res.status(500).json({ message: e.message });
  }
};

export const getMyReviews = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const filter = { user: req.user._id };

    const [items, total] = await Promise.all([
      Reviews.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('product', 'name slug') // thêm field ảnh sản phẩm nếu cần
        .populate('order', 'code')
        .lean(),
      Reviews.countDocuments(filter),
    ]);

    const now = Date.now();
    const data = items.map((r) => ({
      ...r,
      canEdit: !r.editedAt && (now - new Date(r.createdAt).getTime()) / 86400000 <= EDIT_WINDOW_DAYS,
    }));

    res.json({ data, total, page, limit });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
/* ================================================================== */
/* ADMIN                                                               */
/* ================================================================== */

/**
 * GET /admin/reviews?page=1&limit=20&status=visible|hidden&rating=1..5&productId=&unreplied=true
 */
export const adminListReviews = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || '').trim();

    const filter = {};

    // Trạng thái: visible | hidden
    if (['visible', 'hidden'].includes(req.query.status)) filter.status = req.query.status;

    // Số sao: 1..5
    const rating = Number(req.query.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) filter.rating = rating;

    if (req.query.productId && mongoose.isValidObjectId(req.query.productId)) {
      filter.product = req.query.productId;
    }

    // Phản hồi: replied | unreplied (null khớp cả bản ghi cũ chưa có trường reply)
    if (req.query.reply === 'unreplied' || req.query.unreplied === 'true') {
      filter['reply.content'] = { $in: ['', null] };
    } else if (req.query.reply === 'replied') {
      filter['reply.content'] = { $nin: ['', null] };
    }

    // Tìm kiếm: nội dung đánh giá, tên/email khách, tên sản phẩm
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      const [userIds, productIds] = await Promise.all([
        Users().find({ $or: [{ name: regex }, { email: regex }] }).distinct('_id'),
        Products().find({ name: regex }).distinct('_id'),
      ]);
      filter.$or = [{ comment: regex }, { user: { $in: userIds } }, { product: { $in: productIds } }];
    }

    const [items, total, [agg]] = await Promise.all([
      Reviews.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('user', 'name avatar email')
        .populate('product', 'name slug')
        .lean(),
      Reviews.countDocuments(filter),
      // Thống kê toàn bộ đánh giá (không phụ thuộc bộ lọc) cho các thẻ ở FE
      Reviews.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            ratingSum: { $sum: '$rating' },
            unreplied: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$reply.content', ''] }, ''] }, 1, 0] } },
            hidden: { $sum: { $cond: [{ $eq: ['$status', 'hidden'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const stats = {
      total: agg?.total ?? 0,
      avgRating: agg?.total ? Math.round((agg.ratingSum / agg.total) * 10) / 10 : 0,
      unreplied: agg?.unreplied ?? 0,
      hidden: agg?.hidden ?? 0,
    };

    res.json({ data: items, total, page, limit, stats });
  } catch (e) {
    console.log(e);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** PATCH /admin/reviews/:id/status   body: { status: 'visible' | 'hidden' } */
export const setReviewStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['visible', 'hidden'].includes(status)) {
      return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
    }
    const review = await Reviews.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!review) return res.status(404).json({ message: 'Không tìm thấy đánh giá' });
    await Reviews.recalcProductRating(review.product);
    res.json({ data: review });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** POST /admin/reviews/:id/reply   body: { content }   (content rỗng = xoá phản hồi) */
export const replyReview = async (req, res) => {
  try {
    const content = String(req.body.content ?? '').trim();
    if (content.length > MAX_REPLY) {
      return res.status(400).json({ message: `Phản hồi tối đa ${MAX_REPLY} ký tự` });
    }
    const reply = content
      ? { content, repliedAt: new Date(), repliedBy: req.user._id }
      : { content: '', repliedAt: null, repliedBy: null };

    const review = await Reviews.findByIdAndUpdate(req.params.id, { reply }, { new: true });
    if (!review) return res.status(404).json({ message: 'Không tìm thấy đánh giá' });
    res.json({ data: review });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** DELETE /admin/reviews/:id   Xoá hẳn đánh giá + ảnh trên Cloudinary */
export const adminDeleteReview = async (req, res) => {
  try {
    const review = await Reviews.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: 'Không tìm thấy đánh giá' });
    await cleanupImages(review.images);
    await Reviews.recalcProductRating(review.product);
    res.json({ message: 'Đã xóa đánh giá' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};