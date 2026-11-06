import { Router } from 'express';
import {
  getSummary,
  getRevenueChart,
  getOrderStatus,
  getRecentOrders,
  getPromoBanners,
  getTopProducts,
  getRepairSummary,
  getRepairRevenueChart,
  getRepairStatus,
} from '../../controllers/dashboard/dashboardController.js'; // chỉnh lại đường dẫn cho đúng dự án

const router = Router();

// TODO: chỉ cho admin truy cập, ví dụ:
// router.use(verifyToken, requireAdmin)

router.get('/summary', getSummary); //            ?range=7d|30d|90d|year
router.get('/revenue', getRevenueChart); //       ?range=7d|30d|90d|year
router.get('/order-status', getOrderStatus); //   ?range=7d|30d|90d|year
router.get('/recent-orders', getRecentOrders); // ?limit=5
router.get('/banners', getPromoBanners); //       ?type=main&limit=5
router.get('/top-products', getTopProducts); //   ?range=30d&limit=5

// Thống kê sửa chữa
router.get('/repair/summary', getRepairSummary); //   ?range=7d|30d|90d|year
router.get('/repair/revenue', getRepairRevenueChart); // ?range=7d|30d|90d|year
router.get('/repair/status', getRepairStatus); //     ?range=7d|30d|90d|year

export default router;

// Trong app.js / server.js:
//   import dashboardRoutes from './routes/dashboardRoutes.js'
//   app.use('/api/dashboard', dashboardRoutes)