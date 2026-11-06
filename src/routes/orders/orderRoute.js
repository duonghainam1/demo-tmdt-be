import { Router } from 'express';
import * as orderController from '../../controllers/orders/orderController.js';
import authMiddleware from '../../middlewares/authMiddleware.js';

const router = Router();

// Tất cả đều cần đăng nhập
router.use(authMiddleware);

router.get('/', orderController.getMyOrders); // phải đặt TRƯỚC '/:code'
router.post('/', orderController.placeOrder);
router.get('/:code', orderController.getMyOrderByCode);
router.patch('/:code/cancel', orderController.cancelMyOrder);
router.post('/:code/cancel-request', orderController.requestCancelOrder);
router.post('/:code/return-request', orderController.requestReturnOrder);           // khách gửi yêu cầu

export default router;

// Gắn vào app: app.use('/api/orders', orderRoutes);