// routes/warranties/productWarrantyRoutes.js
// Bảo hành sản phẩm đã bán, cho khách đã đăng nhập (dùng cho trang "Bảo hành của tôi" và trang chi tiết đơn).
// Tra cứu công khai (không đăng nhập) đi qua GET /api/repair-requests/warranty trong API gộp.
import { Router } from 'express';
import authMiddleware from "../../middlewares/authMiddleware.js";
import {
  getMyWarranties,
  getMyWarrantiesByOrder,
} from '../../controllers/warranties/warrantyLookupController.js';

const router = Router();

router.get('/warranties', authMiddleware, getMyWarranties); // toàn bộ bảo hành sản phẩm của tôi
router.get('/warranties/order/:code', authMiddleware, getMyWarrantiesByOrder); // bảo hành của 1 đơn

export default router;
// app.use('/api', productWarrantyRoutes);