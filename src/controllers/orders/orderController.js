import * as orderService from '../../services/orders/orderService.js';
import { handle } from '../../utils/handle.js';

// Đặt hàng từ các sản phẩm đang tick trong giỏ. Body: { shippingAddress, paymentMethod, note }
export const placeOrder = handle((req) => orderService.placeOrder(req.user.id, req.body), 201);

// Danh sách đơn của tôi. Query: q, status, paymentMethod, from, to, page, limit
export const getMyOrders = handle((req) => orderService.getMyOrders(req.user.id, req.query));

export const getMyOrderByCode = handle((req) =>
  orderService.getMyOrderByCode(req.user.id, req.params.code)
);

// Tự hủy đơn: chỉ khi đơn đang chờ xác nhận và trong 15 phút đầu. Body: { reason? }
export const cancelMyOrder = handle((req) =>
  orderService.cancelMyOrder(req.user.id, req.params.code, req.body)
);

// Gửi yêu cầu hủy (khi không còn tự hủy được), chờ admin duyệt. Body: { reason }
export const requestCancelOrder = handle((req) =>
  orderService.requestCancelOrder(req.user.id, req.params.code, req.body)
);

// [TRẢ HÀNG] Gửi yêu cầu trả hàng (đơn đã hoàn tất, trong 7 ngày). Body: { reason, items?: [{ orderItem, quantity }] }
export const requestReturnOrder = handle((req) =>
  orderService.requestReturnOrder(req.user.id, req.params.code, req.body)
);