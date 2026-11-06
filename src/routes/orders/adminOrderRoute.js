import { Router } from 'express';
import * as adminOrderController from '../../controllers/orders/adminOrderController.js';
import { loggedIn, requirePermission as need } from '../../middlewares/authMiddleware.js';

const router = Router();

router.use(loggedIn);

router.get('/', need('order:read'), adminOrderController.getAllOrders); // phải đặt TRƯỚC '/:code'
router.get('/:code', need('order:read'), adminOrderController.getOrderByCode);
// Đổi trạng thái: confirmed | shipping | completed | returning | returned | cancelled
router.patch('/:code/status', need('order:update-status'), adminOrderController.updateOrderStatus);
router.patch('/:code/payment', need('order:update'), adminOrderController.updatePaymentStatus);
router.patch('/:code/cancel-request', need('order:cancel'), adminOrderController.resolveCancelRequest);
// Tên quyền lấy tạm từ route đổi trạng thái, đổi lại nếu dự án có quyền riêng
router.patch('/:code/return-request', need('order:update-status'), adminOrderController.resolveReturnRequest); // admin duyệt / từ chối
router.post('/:code/return-complete', need('order:update-status'), adminOrderController.completeReturn); // admin nhận hàng + hoàn tiền

export default router;

// Gắn vào app: app.use('/api/admin/orders', adminOrderRoutes);