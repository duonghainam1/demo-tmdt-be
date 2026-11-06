import * as adminOrderService from '../../services/orders/adminOrderService.js';
import { handle } from '../../utils/handle.js';

// Query: q, status, paymentMethod, paymentStatus, from, to, sort, cancelRequest, returnRequest, page, limit
export const getAllOrders = handle((req) => adminOrderService.getAllOrders(req.query));

export const getOrderByCode = handle((req) => adminOrderService.getOrderByCode(req.params.code));

// Body: { status: confirmed | shipping | completed | returning | returned | cancelled, note?, shipping?: { carrier, trackingCode } }
// shipping bắt buộc khi status = shipping (carrier: jnt | viettel_post | ghtk | ghn)
// Luồng: shipping -> completed (giao thành công) | shipping -> returning -> returned (giao thất bại / bom hàng)
export const updateOrderStatus = handle((req) =>
  adminOrderService.updateOrderStatus(req.user.id, req.params.code, req.body)
);

// Body: { paymentStatus: paid | refunded }
export const updatePaymentStatus = handle((req) =>
  adminOrderService.updatePaymentStatus(req.params.code, req.body)
);

// Duyệt / từ chối yêu cầu hủy của khách. Body: { action: approve | reject, note? }
export const resolveCancelRequest = handle((req) =>
  adminOrderService.resolveCancelRequest(req.user.id, req.params.code, req.body)
);

// [TRẢ HÀNG] Duyệt / từ chối yêu cầu trả hàng. Body: { action: approve | reject, note? } (reject bắt buộc có note)
export const resolveReturnRequest = handle((req) =>
  adminOrderService.resolveReturnRequest(req.user.id, req.params.code, req.body)
);

// [TRẢ HÀNG] Đã nhận hàng trả + hoàn tiền. Body: { items?: [{ orderItem, restock }], refundAmount?, note? }
export const completeReturn = handle((req) =>
  adminOrderService.completeReturn(req.user.id, req.params.code, req.body)
);