import mongoose from 'mongoose';
import Carts from '../../models/cart/cartModel.js';
import Orders, { PAYMENT_METHODS } from '../../models/orders/ordersModel.js';
import Products from '../../models/products/productModel.js'; // [BẢO HÀNH] đọc warrantyMonths khi đặt hàng
import { buildCartView, HttpError } from '../../services/cart/cartService.js'; // chỉnh đường dẫn cho đúng dự án
import { reserveVoucher } from '../voucher/voucherService.js';
import {
  RETURN_WINDOW_MS,
  USER_CANCEL_WINDOW_MS,
  asVoucherError,
  clean,
  explainCancelFailure,
  explainRequestFailure,
  explainReturnFailure,
  getReturnPolicy,
  listOrders,
  normalizeReturnItems,
  releaseOrderReservations,
  reserveFlashForOrder,
  reserveOrderStock,
  withOrderPolicies,
} from './orderHelpers.js';

/* ------------------------------ helper ------------------------------ */
const PHONE_REGEX = /^(0|\+?84)(3|5|7|8|9)\d{8}$/; // số di động Việt Nam

// Ép về số hợp lệ, undefined / null / NaN / chuỗi rác -> 0 (tránh NaN lan ra total)
const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Mã đơn: NX + yymmdd + 6 ký tự ngẫu nhiên, vd NX260929AB12CD
const generateOrderCode = () => {
  const d = new Date();
  const ymd =
    String(d.getFullYear()).slice(2) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `NX${ymd}${rand}`;
};

/** Kiểm tra dữ liệu người dùng gửi lên, trả về dữ liệu đã làm sạch. */
const validatePayload = (payload = {}) => {
  const a = payload.shippingAddress || {};
  const shippingAddress = {
    fullName: clean(a.fullName),
    phone: clean(a.phone).replace(/[\s.-]/g, ''),
    province: clean(a.province),
    ward: clean(a.ward),
    addressLine: clean(a.addressLine),
  };

  if (!shippingAddress.fullName) throw new HttpError(400, 'Vui lòng nhập họ tên người nhận', 'INVALID_ADDRESS');
  if (!PHONE_REGEX.test(shippingAddress.phone)) {
    throw new HttpError(400, 'Số điện thoại không hợp lệ', 'INVALID_PHONE');
  }
  if (!shippingAddress.province || !shippingAddress.ward || !shippingAddress.addressLine) {
    throw new HttpError(400, 'Vui lòng nhập đầy đủ địa chỉ nhận hàng', 'INVALID_ADDRESS');
  }

  const paymentMethod = payload.paymentMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new HttpError(400, 'Phương thức thanh toán không hợp lệ', 'INVALID_PAYMENT_METHOD');
  }

  const note = clean(payload.note).slice(0, 500);

  return { shippingAddress, paymentMethod, note };
};

const isFlashLimitOnly = (i) => i.issues.length === 1 && i.issues[0] === 'FLASH_LIMIT';

/* ------------------------------ nghiệp vụ ------------------------------ */
/**
 * Đặt hàng từ các dòng đang được TICK trong giỏ.
 * FE không gửi danh sách sản phẩm hay giá: BE tự đọc từ giỏ và tính lại toàn bộ.
 *
 * Trong 1 transaction:
 *   1) giữ tồn kho (tăng reservedQuantity, có điều kiện còn đủ hàng) + ghi InventoryTransactions
 *   2) dòng nào đang hưởng giá giờ vàng: giữ suất giờ vàng
 *   3) giữ chỗ voucher (kiểm tra lại, tăng usedCount, ghi VoucherUsage "reserved")
 *   4) tạo đơn hàng (lưu voucherCode + discount)
 *   5) xoá các dòng đã mua khỏi giỏ và bỏ voucher khỏi giỏ
 * Bất kỳ bước nào lỗi thì huỷ tất cả.
 *
 * YÊU CẦU: MongoDB chạy replica set (Atlas mặc định có sẵn) thì mới dùng được transaction.
 */
export const placeOrder = async (userId, payload) => {
  const { shippingAddress, paymentMethod, note } = validatePayload(payload);

  const cart = await Carts.findOne({ user: userId });
  const view = await buildCartView(cart);

  const selected = view.items.filter((i) => i.selected);
  if (selected.length === 0) {
    throw new HttpError(400, 'Bạn chưa chọn sản phẩm nào để thanh toán', 'EMPTY_SELECTION');
  }

  const blocked = selected.filter((i) => !i.isPurchasable);
  if (blocked.length > 0) {
    if (blocked.every(isFlashLimitOnly)) {
      throw new HttpError(
        409,
        `Vượt giới hạn mua giá giờ vàng: ${blocked
          .map((i) => `${i.name} (tối đa ${i.flashMaxQuantity})`)
          .join(', ')}. Vui lòng giảm số lượng.`,
        'FLASH_LIMIT'
      );
    }
    throw new HttpError(
      409,
      `Có sản phẩm không thể mua: ${blocked.map((i) => i.name).join(', ')}. Vui lòng bỏ chọn hoặc xoá khỏi giỏ hàng.`,
      'ITEMS_UNAVAILABLE'
    );
  }

  // Giỏ có gắn voucher nhưng đang không hợp lệ -> chặn, báo khách (không âm thầm bỏ voucher)
  if (view.voucher?.error) {
    throw new HttpError(409, `Voucher không hợp lệ: ${view.voucher.error}`, 'VOUCHER_INVALID');
  }
  const voucherCode = view.voucher?.code ?? null;

  // subtotal / shippingFee tính ở BE (chỉ gồm các dòng tick + mua được).
  // discount KHÔNG lấy từ view.summary mà lấy từ reserveVoucher trong transaction.
  // Dùng toMoney để tránh undefined/NaN làm hỏng total; subtotal có fallback cộng từ lineTotal.
  const subtotal = toMoney(
    view.summary?.subtotal ?? selected.reduce((sum, i) => sum + toMoney(i.lineTotal), 0)
  );
  const shippingFee = toMoney(view.summary?.shippingFee);

  const orderId = new mongoose.Types.ObjectId();
  const code = generateOrderCode();

  // [BẢO HÀNH] Chốt số tháng bảo hành của từng sản phẩm tại thời điểm đặt hàng
  const warrantyRows = await Products.find({
    _id: { $in: [...new Set(selected.map((i) => String(i.productId)))] },
  })
    .select('warrantyMonths')
    .lean();
  const warrantyOf = new Map(warrantyRows.map((p) => [String(p._id), p.warrantyMonths || 0]));

  const orderItems = selected.map((i) => ({
    product: i.productId,
    variant: i.variantId,
    sku: i.sku,
    name: i.name,
    image: i.image,
    attributes: i.attributes,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    originalPrice: i.originalPrice ?? i.unitPrice,
    lineTotal: i.lineTotal,
    flashSaleItem: i.flashItemId ?? null, // truy vết dòng nào mua theo giá giờ vàng
    warrantyMonths: warrantyOf.get(String(i.productId)) ?? 0, // [BẢO HÀNH]
  }));

  // Dữ liệu để voucher service tính lại tiền giảm (giá lấy từ DB đã dựng ở cart view)
  const voucherCart = {
    items: selected.map((i) => ({
      product: i.productId,
      category: i.categoryId,
      price: i.unitPrice,
      quantity: i.quantity,
    })),
    shippingFee,
  };

  const session = await mongoose.startSession();
  try {
    let order;

    // withTransaction có thể chạy lại callback khi gặp lỗi tạm thời (vd WriteConflict),
    // nên mọi biến dùng trong callback phải khai báo bên trong hoặc gán lại mỗi lần chạy.
    await session.withTransaction(async () => {
      // 1) giữ tồn kho + ghi lịch sử kho
      await reserveOrderStock(
        selected.map((i) => ({ variant: i.variantId, quantity: i.quantity, name: i.name })),
        { code, orderId, userId },
        session
      );

      // 2) giữ suất giờ vàng
      for (const it of selected) {
        if (!it.isFlashSale) continue;
        const purchase = await reserveFlashForOrder(
          { itemId: it.flashItemId, userId, orderId, qty: it.quantity },
          session
        );
        // Giá giờ vàng bị admin sửa giữa lúc xem giỏ và lúc đặt -> không đặt với giá cũ
        if (purchase.unitPrice !== it.unitPrice) {
          throw new HttpError(
            409,
            'Giá giờ vàng vừa thay đổi, vui lòng kiểm tra lại giỏ hàng',
            'PRICE_CHANGED'
          );
        }
      }

      // 3) giữ chỗ voucher (validate lại với dữ liệu mới nhất trong cùng transaction)
      let discount = 0;
      let voucherId = null;
      if (voucherCode) {
        const r = await asVoucherError(() =>
          reserveVoucher(voucherCode, userId, orderId, voucherCart, session)
        );
        discount = toMoney(r.discountAmount ?? r.discount);
        voucherId = r.voucher?._id ?? null;
      }
      const total = Math.max(0, subtotal + shippingFee - discount);

      if (!Number.isFinite(total)) {
        console.error('[order] total không hợp lệ:', { subtotal, shippingFee, discount, total });
        throw new HttpError(500, 'Không tính được tổng tiền đơn hàng', 'INVALID_TOTAL');
      }

      // 4) tạo đơn hàng
      const [created] = await Orders.create(
        [
          {
            _id: orderId,
            code,
            user: userId,
            items: orderItems,
            shippingAddress,
            note,
            paymentMethod,
            paymentStatus: 'unpaid',
            status: 'pending',
            statusHistory: [{ status: 'pending', note: 'Khách đặt hàng', changedBy: userId }],
            subtotal,
            shippingFee,
            discount,
            total,
            voucherCode,
            voucher: voucherId,
          },
        ],
        { session }
      );
      order = created;

      // 5) xoá các dòng đã mua khỏi giỏ + bỏ voucher đã dùng (theo _id nên chạy lại vẫn an toàn)
      await Carts.updateOne(
        { user: userId },
        {
          $pull: { items: { _id: { $in: selected.map((i) => i.id) } } },
          $set: { voucherCode: null },
        },
        { session }
      );
    });

    return order;
  } finally {
    await session.endSession();
  }
};

/** Xem 1 đơn của chính mình theo mã đơn. */
export const getMyOrderByCode = async (userId, code) => {
  const order = await Orders.findOne({ code: String(code).toUpperCase(), user: userId }).lean();
  if (!order) throw new HttpError(404, 'Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND');
  return withOrderPolicies(order);
};

/**
 * Danh sách đơn của CHÍNH người dùng (tìm kiếm + lọc + phân trang, xem listOrders).
 * Giữ statusHistory để FE vẽ ngày trên thanh tiến trình.
 */
export const getMyOrders = async (userId, query = {}) => {
  const data = await listOrders({ user: new mongoose.Types.ObjectId(userId) }, query);
  return { ...data, items: data.items.map(withOrderPolicies) };
};

/**
 * Khách tự huỷ đơn của mình. CHỈ được khi đơn còn "pending" VÀ trong vòng
 * USER_CANCEL_WINDOW_MINUTES phút (mặc định 15) kể từ lúc đặt.
 * Ngoài điều kiện đó khách phải gửi yêu cầu hủy (requestCancelOrder) và chờ admin duyệt.
 *
 * Trong 1 transaction:
 *   1) đổi trạng thái đơn -> cancelled (có điều kiện status + thời gian, nên bấm 2 lần không huỷ đôi)
 *   2) trả lại mọi thứ đã giữ: tồn kho, suất giờ vàng, lượt voucher
 */
export const cancelMyOrder = async (userId, code, payload = {}) => {
  const orderCode = String(code).toUpperCase();
  const reason = clean(payload.reason).slice(0, 300);
  const cutoff = new Date(Date.now() - USER_CANCEL_WINDOW_MS);

  const session = await mongoose.startSession();
  try {
    let order;

    await session.withTransaction(async () => {
      order = await Orders.findOneAndUpdate(
        { code: orderCode, user: userId, status: 'pending', createdAt: { $gte: cutoff } },
        {
          $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
          $push: {
            statusHistory: { status: 'cancelled', note: reason || 'Khách huỷ đơn', changedBy: userId },
          },
        },
        { returnDocument: 'after', session }
      );

      if (!order) {
        const current = await Orders.findOne({ code: orderCode, user: userId })
          .select('status createdAt cancelRequest')
          .session(session)
          .lean();
        if (!current) throw new HttpError(404, 'Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND');
        throw explainCancelFailure(current);
      }

      await releaseOrderReservations(order, userId, session);
    });

    return order;
  } finally {
    await session.endSession();
  }
};

/**
 * Khách gửi YÊU CẦU HỦY khi không còn tự hủy được:
 *   - đơn "pending" nhưng đã quá thời gian cho phép, hoặc
 *   - đơn "confirmed".
 * Đơn giữ nguyên trạng thái, admin duyệt (approve) thì mới hủy thật. Mỗi đơn chỉ gửi được 1 yêu cầu.
 */
export const requestCancelOrder = async (userId, code, payload = {}) => {
  const orderCode = String(code).toUpperCase();
  const reason = clean(payload.reason).slice(0, 300);
  if (!reason) throw new HttpError(400, 'Vui lòng nhập lý do hủy đơn', 'REASON_REQUIRED');

  const cutoff = new Date(Date.now() - USER_CANCEL_WINDOW_MS);

  const order = await Orders.findOneAndUpdate(
    {
      code: orderCode,
      user: userId,
      $or: [{ status: 'confirmed' }, { status: 'pending', createdAt: { $lt: cutoff } }],
      // chưa từng gửi yêu cầu (hoặc đơn cũ chưa có trường này)
      'cancelRequest.status': { $nin: ['pending', 'approved', 'rejected'] },
    },
    { $set: { cancelRequest: { status: 'pending', reason, requestedAt: new Date() } } },
    { returnDocument: 'after' }
  ).lean();

  if (!order) {
    const current = await Orders.findOne({ code: orderCode, user: userId })
      .select('status createdAt cancelRequest')
      .lean();
    if (!current) throw new HttpError(404, 'Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND');
    throw explainRequestFailure(current);
  }

  return withOrderPolicies(order);
};

/**
 * [TRẢ HÀNG] Khách gửi YÊU CẦU TRẢ HÀNG cho đơn đã completed,
 * trong RETURN_WINDOW_DAYS ngày (mặc định 7) kể từ lúc hoàn tất.
 *
 * payload: { reason, items?: [{ orderItem, quantity }] }   (không gửi items = trả toàn bộ đơn)
 * Đơn giữ nguyên status "completed"; admin duyệt, nhận hàng rồi mới hoàn kho + hoàn tiền.
 * Mỗi đơn chỉ gửi được 1 yêu cầu.
 */
export const requestReturnOrder = async (userId, code, payload = {}) => {
  const orderCode = String(code).toUpperCase();
  const reason = clean(payload.reason).slice(0, 300);
  if (!reason) throw new HttpError(400, 'Vui lòng nhập lý do trả hàng', 'REASON_REQUIRED');

  const current = await Orders.findOne({ code: orderCode, user: userId }).lean();
  if (!current) throw new HttpError(404, 'Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND');

  if (getReturnPolicy(current).mode !== 'request') throw explainReturnFailure(current);

  const items = normalizeReturnItems(current, payload.items);
  if (items.length === 0) throw new HttpError(400, 'Không có sản phẩm nào để trả', 'INVALID_RETURN_ITEMS');

  const cutoff = new Date(Date.now() - RETURN_WINDOW_MS);

  // Mọi điều kiện nằm trong filter nên bấm 2 lần / gửi song song chỉ tạo được 1 yêu cầu
  const order = await Orders.findOneAndUpdate(
    {
      _id: current._id,
      user: userId,
      status: 'completed',
      'returnRequest.status': { $nin: ['pending', 'approved', 'rejected', 'completed'] },
      statusHistory: { $elemMatch: { status: 'completed', changedAt: { $gte: cutoff } } },
    },
    { $set: { returnRequest: { status: 'pending', reason, items, requestedAt: new Date() } } },
    { returnDocument: 'after' }
  ).lean();

  if (!order) throw explainReturnFailure(current);
  return withOrderPolicies(order);
};