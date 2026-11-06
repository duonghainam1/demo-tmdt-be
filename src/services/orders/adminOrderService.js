import Orders, { CARRIERS } from '../../models/orders/ordersModel.js';
import { HttpError } from '../../utils/httpError.js';
import {
  assertOrderExists,
  calcRefundAmount,
  clean,
  completeOrderReservations,
  findOrderByCode,
  historyEntry,
  listOrders,
  releaseOrderReservations,
  returnOrderStock,
  runInTransaction,
  subtractProductSoldCount,
  toOrderCode,
} from './orderHelpers.js';

/**
 * Danh sách TẤT CẢ đơn hàng (admin), có tìm kiếm + lọc + phân trang.
 * Query: q, status, paymentMethod, paymentStatus, from, to, sort, cancelRequest, returnRequest, page, limit
 * (xem listOrders). Bỏ statusHistory cho nhẹ, chi tiết đơn sẽ có đầy đủ.
 */
export const getAllOrders = (query = {}) =>
  listOrders({}, query, { select: '-statusHistory -__v' });

/** Chi tiết 1 đơn bất kỳ theo mã đơn, kèm thông tin khách. */
export const getOrderByCode = (code) =>
  findOrderByCode(code, {
    populate: ['user', 'fullName name email phone avatar'], // chỉnh theo trường thật của model Users
  });

/* ------------------------------ đổi trạng thái ------------------------------ */
// Trạng thái đích -> các trạng thái hiện tại được phép chuyển từ đó
const TRANSITIONS = {
  confirmed: ['pending'],
  shipping: ['confirmed'],
  completed: ['shipping'],
  returning: ['shipping'], // giao thất bại / khách bom hàng
  returned: ['returning'], // hàng hoàn về tới kho
  cancelled: ['pending', 'confirmed'],
};

const DEFAULT_NOTE = {
  confirmed: 'Cửa hàng xác nhận đơn',
  shipping: 'Bắt đầu giao hàng',
  completed: 'Giao hàng thành công',
  returning: 'Giao hàng không thành công, chờ nhận hàng hoàn',
  returned: 'Đã nhận hàng hoàn, trả hàng về kho',
  cancelled: 'Cửa hàng huỷ đơn',
};

// Mã vận đơn: 6-30 ký tự chữ, số hoặc dấu gạch ngang
const TRACKING_CODE_REGEX = /^[A-Z0-9-]{6,30}$/;

/**
 * Admin đổi trạng thái đơn theo luồng:
 *   pending -> confirmed -> shipping -> completed
 *                                    -> returning -> returned   (giao thất bại / khách bom hàng)
 *   pending | confirmed -> cancelled   (đơn đã giao đi thì không huỷ được)
 * Đơn đang có yêu cầu hủy chờ duyệt chỉ được chuyển sang cancelled, các bước khác phải
 * duyệt hoặc từ chối yêu cầu trước (resolveCancelRequest).
 *
 * payload: { status, note?, shipping?: { carrier, trackingCode } }
 *   shipping BẮT BUỘC khi status = shipping, được lưu cùng lúc với việc đổi trạng thái.
 *
 * Trong 1 transaction:
 *   1) đổi trạng thái có điều kiện (status hiện tại phải hợp lệ), ghi statusHistory
 *   2) completed: trừ tồn thật (giảm quantity và reservedQuantity).
 *      KHÔNG tự đổi paymentStatus: admin tự xác nhận đã thu tiền (kể cả đơn COD)
 *      qua updatePaymentStatus để quản lý dòng tiền.
 *      cancelled | returned: trả hàng đã giữ (tồn kho, suất giờ vàng, voucher)
 *      (confirmed, shipping, returning: hàng vẫn ở trạng thái đã giữ, không đổi tồn kho)
 */
export const updateOrderStatus = async (adminId, code, payload = {}) => {
  const to = clean(payload.status);
  if (!TRANSITIONS[to]) {
    throw new HttpError(400, 'Trạng thái không hợp lệ', 'INVALID_STATUS');
  }
  const note = clean(payload.note).slice(0, 300);
  const orderCode = toOrderCode(code);

  // Chuyển sang đang giao: bắt buộc có đơn vị vận chuyển + mã vận đơn
  let shipping = null;
  if (to === 'shipping') {
    const carrier = clean(payload.shipping?.carrier);
    const trackingCode = clean(payload.shipping?.trackingCode).toUpperCase();
    if (!CARRIERS.includes(carrier)) {
      throw new HttpError(400, 'Vui lòng chọn đơn vị vận chuyển hợp lệ', 'INVALID_CARRIER');
    }
    if (!TRACKING_CODE_REGEX.test(trackingCode)) {
      throw new HttpError(
        400,
        'Mã vận đơn không hợp lệ (6-30 ký tự chữ, số hoặc dấu gạch ngang)',
        'INVALID_TRACKING_CODE'
      );
    }
    shipping = { carrier, trackingCode };
  }

  await runInTransaction(async (session) => {
    const set = { status: to };
    if (to === 'cancelled') {
      set.cancelledAt = new Date();
      set.cancelReason = note;
    }
    if (shipping) {
      set['shipping.carrier'] = shipping.carrier;
      set['shipping.trackingCode'] = shipping.trackingCode;
      set['shipping.shippedAt'] = new Date();
    }

    const filter = { code: orderCode, status: { $in: TRANSITIONS[to] } };
    if (to !== 'cancelled') filter['cancelRequest.status'] = { $ne: 'pending' };

    // new: false -> nhận lại đơn TRƯỚC khi đổi (để biết items, paymentMethod)
    const prev = await Orders.findOneAndUpdate(
      filter,
      {
        $set: set,
        $push: { statusHistory: historyEntry(to, note || DEFAULT_NOTE[to], adminId) },
      },
      { new: false, session }
    );

    if (!prev) {
      const current = await Orders.findOne({ code: orderCode })
        .select('status cancelRequest')
        .session(session)
        .lean();
      if (!current) await assertOrderExists(orderCode); // ném 404
      if (to !== 'cancelled' && current.cancelRequest?.status === 'pending') {
        throw new HttpError(
          409,
          'Đơn đang có yêu cầu hủy chờ xử lý, hãy duyệt hoặc từ chối yêu cầu trước',
          'CANCEL_REQUEST_PENDING'
        );
      }
      throw new HttpError(
        409,
        `Không thể chuyển đơn từ "${current.status}" sang "${to}"`,
        'INVALID_TRANSITION'
      );
    }

    if (to === 'completed') await completeOrderReservations(prev, adminId, session);
    // Hủy đơn hoặc hàng hoàn về kho: trả lại tồn kho + suất giờ vàng + lượt voucher
    if (to === 'cancelled' || to === 'returned') await releaseOrderReservations(prev, adminId, session);

    // Admin hủy thẳng khi khách đang chờ duyệt yêu cầu hủy -> coi như đã duyệt
    if (to === 'cancelled' && prev.cancelRequest?.status === 'pending') {
      await Orders.updateOne(
        { _id: prev._id },
        {
          $set: {
            'cancelRequest.status': 'approved',
            'cancelRequest.resolvedAt': new Date(),
            'cancelRequest.resolvedBy': adminId,
          },
        },
        { session }
      );
    }

    // LƯU Ý: không tự chuyển paymentStatus sang 'paid' khi completed (kể cả COD).
    // Admin tự bấm "Xác nhận đã thanh toán" sau khi thực sự thu được tiền (updatePaymentStatus).
  });

  return Orders.findOne({ code: orderCode }).lean();
};

/* ------------------------------ thanh toán ------------------------------ */
/**
 * Admin xác nhận thanh toán (COD sau khi thu tiền, hoặc chuyển khoản) hoặc hoàn tiền.
 *   unpaid -> paid      : đơn chưa bị huỷ / chưa hoàn về kho (đơn đã giao completed vẫn xác nhận được)
 *   paid   -> refunded  : đơn đã huỷ hoặc đã hoàn về kho
 * Chỉ đổi cờ trong hệ thống, việc chuyển tiền hoàn thực tế làm bên ngoài.
 * (Hoàn tiền do KHÁCH TRẢ HÀNG đi riêng qua completeReturn, không dùng hàm này.)
 */
const PAYMENT_RULES = {
  paid: { from: 'unpaid', status: { $nin: ['cancelled', 'returned'] } },
  refunded: { from: 'paid', status: { $in: ['cancelled', 'returned'] } },
};

export const updatePaymentStatus = async (code, payload = {}) => {
  const to = clean(payload.paymentStatus);
  const rule = PAYMENT_RULES[to];
  if (!rule) throw new HttpError(400, 'Trạng thái thanh toán không hợp lệ', 'INVALID_PAYMENT_STATUS');

  const orderCode = toOrderCode(code);
  const order = await Orders.findOneAndUpdate(
    { code: orderCode, paymentStatus: rule.from, status: rule.status },
    { $set: { paymentStatus: to } },
    { new: true }
  ).lean();

  if (!order) {
    await assertOrderExists(orderCode);
    throw new HttpError(409, 'Không thể đổi trạng thái thanh toán của đơn này', 'INVALID_PAYMENT_TRANSITION');
  }
  return order;
};

/* ------------------------------ yêu cầu hủy của khách ------------------------------ */
const noPendingRequest = () =>
  new HttpError(409, 'Đơn này không có yêu cầu hủy đang chờ xử lý', 'NO_CANCEL_REQUEST');

/**
 * Admin duyệt hoặc từ chối YÊU CẦU HỦY của khách.
 * payload: { action: 'approve' | 'reject', note? }
 *   approve: hủy đơn + trả hàng đã giữ (1 transaction), lý do hủy lấy từ yêu cầu của khách
 *   reject:  giữ nguyên đơn, khách không gửi lại được yêu cầu khác (note là lý do từ chối)
 */
export const resolveCancelRequest = async (adminId, code, payload = {}) => {
  const action = clean(payload.action);
  if (!['approve', 'reject'].includes(action)) {
    throw new HttpError(400, 'Hành động không hợp lệ (approve hoặc reject)', 'INVALID_ACTION');
  }
  const note = clean(payload.note).slice(0, 300);
  const orderCode = toOrderCode(code);
  const now = new Date();

  if (action === 'reject') {
    const order = await Orders.findOneAndUpdate(
      { code: orderCode, 'cancelRequest.status': 'pending' },
      {
        $set: {
          'cancelRequest.status': 'rejected',
          'cancelRequest.resolvedAt': now,
          'cancelRequest.resolvedBy': adminId,
          'cancelRequest.adminNote': note,
        },
      },
      { new: true }
    ).lean();

    if (!order) {
      await assertOrderExists(orderCode);
      throw noPendingRequest();
    }
    return order;
  }

  // approve
  await runInTransaction(async (session) => {
    const cur = await Orders.findOne({ code: orderCode }).session(session).lean();
    if (!cur) await assertOrderExists(orderCode); // ném 404
    if (cur.cancelRequest?.status !== 'pending' || !['pending', 'confirmed'].includes(cur.status)) {
      throw noPendingRequest();
    }

    const prev = await Orders.findOneAndUpdate(
      { _id: cur._id, 'cancelRequest.status': 'pending', status: { $in: ['pending', 'confirmed'] } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelReason: cur.cancelRequest.reason,
          'cancelRequest.status': 'approved',
          'cancelRequest.resolvedAt': now,
          'cancelRequest.resolvedBy': adminId,
          'cancelRequest.adminNote': note,
        },
        $push: {
          statusHistory: historyEntry(
            'cancelled',
            note ? `Duyệt yêu cầu hủy: ${note}` : 'Duyệt yêu cầu hủy của khách',
            adminId
          ),
        },
      },
      { new: false, session }
    );
    if (!prev) throw noPendingRequest();

    await releaseOrderReservations(prev, adminId, session);
  });

  return Orders.findOne({ code: orderCode }).lean();
};

/* ------------------------------ [TRẢ HÀNG] yêu cầu trả hàng của khách ------------------------------ */
const noPendingReturn = () =>
  new HttpError(409, 'Đơn này không có yêu cầu trả hàng đang chờ duyệt', 'NO_RETURN_REQUEST');

/**
 * Admin duyệt hoặc từ chối YÊU CẦU TRẢ HÀNG.
 * payload: { action: 'approve' | 'reject', note? }
 *   approve: chờ khách gửi hàng về, CHƯA đổi kho / tiền (xem completeReturn)
 *   reject:  đóng yêu cầu, khách không gửi lại được (note bắt buộc, là lý do từ chối)
 */
export const resolveReturnRequest = async (adminId, code, payload = {}) => {
  const action = clean(payload.action);
  if (!['approve', 'reject'].includes(action)) {
    throw new HttpError(400, 'Hành động không hợp lệ (approve hoặc reject)', 'INVALID_ACTION');
  }
  const note = clean(payload.note).slice(0, 300);
  const orderCode = toOrderCode(code);

  if (action === 'reject' && !note) {
    throw new HttpError(400, 'Vui lòng nhập lý do từ chối', 'NOTE_REQUIRED');
  }

  const order = await Orders.findOneAndUpdate(
    { code: orderCode, 'returnRequest.status': 'pending' },
    {
      $set: {
        'returnRequest.status': action === 'approve' ? 'approved' : 'rejected',
        'returnRequest.resolvedAt': new Date(),
        'returnRequest.resolvedBy': adminId,
        'returnRequest.adminNote': note,
      },
    },
    { new: true }
  ).lean();

  if (!order) {
    await assertOrderExists(orderCode);
    throw noPendingReturn();
  }
  return order;
};

/**
 * Admin xác nhận ĐÃ NHẬN HÀNG TRẢ + hoàn tiền (chỉ với yêu cầu đã approved).
 *
 * payload: {
 *   items?: [{ orderItem, restock }]   restock mặc định true; false = hàng lỗi, không nhập lại kho
 *   refundAmount?: number              mặc định = số tính tự động; chỉ được nhỏ hơn hoặc bằng (vd trừ phí)
 *   note?
 * }
 *
 * Trong 1 transaction:
 *   1) chuyển returnRequest approved -> completed (có điều kiện, bấm 2 lần không cộng kho 2 lần)
 *   2) tăng returnedQuantity từng dòng
 *   3) nhập lại kho các dòng restock + ghi InventoryTransactions (type "return")
 *   4) giảm Products.soldCount (cả hàng lỗi, vì khách đã trả)
 *   5) cộng refundedAmount, cập nhật paymentStatus (partially_refunded | refunded)
 * Việc chuyển tiền thực tế làm bên ngoài, giống updatePaymentStatus.
 * Đơn chưa được admin xác nhận đã thanh toán (paymentStatus = unpaid) thì refundAmount = 0,
 * nên admin cần xác nhận đã thu tiền trước khi hoàn tiền cho khách.
 */
export const completeReturn = async (adminId, code, payload = {}) => {
  const orderCode = toOrderCode(code);
  const note = clean(payload.note).slice(0, 300);

  const restockMap = new Map();
  if (payload.items !== undefined && payload.items !== null) {
    if (!Array.isArray(payload.items)) {
      throw new HttpError(400, 'Danh sách sản phẩm không hợp lệ', 'INVALID_RETURN_ITEMS');
    }
    payload.items.forEach((x) => restockMap.set(String(x?.orderItem), x?.restock !== false));
  }

  await runInTransaction(async (session) => {
    const cur = await Orders.findOne({ code: orderCode }).session(session).lean();
    if (!cur) await assertOrderExists(orderCode); // ném 404
    if (cur.returnRequest?.status !== 'approved') {
      throw new HttpError(409, 'Đơn này chưa có yêu cầu trả hàng được duyệt', 'NO_APPROVED_RETURN');
    }

    const lines = new Map(cur.items.map((l) => [String(l._id), l]));
    const returnItems = cur.returnRequest.items.map((ri) => ({
      orderItem: ri.orderItem,
      quantity: ri.quantity,
      restock: restockMap.has(String(ri.orderItem)) ? restockMap.get(String(ri.orderItem)) : true,
    }));

    // ----- tiền hoàn -----
    const maxRefund = calcRefundAmount(cur, returnItems);
    let refund = maxRefund;
    if (payload.refundAmount !== undefined && payload.refundAmount !== null) {
      refund = Number(payload.refundAmount);
      if (!Number.isInteger(refund) || refund < 0 || refund > maxRefund) {
        throw new HttpError(
          400,
          `Số tiền hoàn phải từ 0 đến ${maxRefund.toLocaleString('vi-VN')}đ`,
          'INVALID_REFUND_AMOUNT'
        );
      }
    }
    // Đơn chưa thanh toán thì không có tiền để hoàn
    const wasPaid = ['paid', 'partially_refunded'].includes(cur.paymentStatus);
    if (!wasPaid) refund = 0;

    const returnedNow = new Map(returnItems.map((r) => [String(r.orderItem), r.quantity]));
    const isFullReturn = cur.items.every(
      (l) => (l.returnedQuantity || 0) + (returnedNow.get(String(l._id)) || 0) >= l.quantity
    );

    const set = {
      'returnRequest.status': 'completed',
      'returnRequest.items': returnItems,
      'returnRequest.refundAmount': refund,
      'returnRequest.completedAt': new Date(),
      'returnRequest.completedBy': adminId,
    };
    if (note) set['returnRequest.adminNote'] = note;
    if (wasPaid) set.paymentStatus = isFullReturn ? 'refunded' : 'partially_refunded';

    // Có điều kiện status: bấm trùng chỉ 1 request thắng
    const prev = await Orders.findOneAndUpdate(
      { _id: cur._id, 'returnRequest.status': 'approved' },
      { $set: set, $inc: { refundedAmount: refund } },
      { new: false, session }
    );
    if (!prev) {
      throw new HttpError(409, 'Yêu cầu trả hàng đã được xử lý', 'RETURN_ALREADY_COMPLETED');
    }

    // ----- returnedQuantity từng dòng -----
    for (const r of returnItems) {
      await Orders.updateOne(
        { _id: cur._id },
        { $inc: { 'items.$[l].returnedQuantity': r.quantity } },
        { arrayFilters: [{ 'l._id': r.orderItem }], session }
      );
    }

    // ----- nhập lại kho (chỉ hàng còn bán được) -----
    const restockItems = returnItems
      .filter((r) => r.restock)
      .map((r) => {
        const l = lines.get(String(r.orderItem));
        return { variant: l.variant, quantity: r.quantity, name: l.name };
      });
    if (restockItems.length) await returnOrderStock(cur, restockItems, adminId, session);

    // ----- số đã bán: giảm cho mọi hàng bị trả, kể cả hàng lỗi -----
    await subtractProductSoldCount(
      returnItems.map((r) => ({ product: lines.get(String(r.orderItem)).product, quantity: r.quantity })),
      session
    );
  });

  return Orders.findOne({ code: orderCode }).lean();
};