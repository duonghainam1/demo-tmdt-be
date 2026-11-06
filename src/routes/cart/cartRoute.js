import { Router } from 'express';
import * as cartController from '../../controllers/cart/cartController.js';
import authMiddleware from '../../middlewares/authMiddleware.js';

const router = Router();

// Tất cả API giỏ hàng đều yêu cầu đăng nhập
router.use(authMiddleware);

router.get('/', cartController.getCart);
router.delete('/', cartController.clearCart);

router.post('/items', cartController.addItem);
router.patch('/items/:itemId', cartController.updateItem);
router.delete('/items/:itemId', cartController.removeItem);

router.patch('/select-all', cartController.setAllSelected);

// Voucher của giỏ: body { code } khi gắn
router.post('/voucher', cartController.applyVoucher);
router.delete('/voucher', cartController.removeVoucher);

export default router;

// Đăng ký trong app: app.use('/api/cart', cartRoutes);