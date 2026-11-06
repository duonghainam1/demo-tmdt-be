import { Router } from 'express';
import {
  getProductReviews,
  getOrderReviews,
  getPendingReviews,
  getMyReviews,
  createOrderReviews,
  updateReview,
  adminListReviews,
  setReviewStatus,
  replyReview,
  adminDeleteReview,
} from '../../controllers/reviews/reviewController.js';
import uploadMiddleware from '../../middlewares/uploadMiddleware.js';
import authMiddleware, { can } from '../../middlewares/authMiddleware.js';

const router = Router();

/* ----- Công khai ----- */
router.get('/products/:productId/reviews', getProductReviews);

/* ----- Khách hàng (đăng nhập) ----- */
router.get('/pending', authMiddleware, getPendingReviews);
router.get('/mine', authMiddleware, getMyReviews);
router.get('/order/:orderId', authMiddleware, getOrderReviews);
router.post('/orders/:orderId/reviews', authMiddleware, uploadMiddleware.any(), createOrderReviews);
router.put('/:id', authMiddleware, uploadMiddleware.any(), updateReview);

/* ----- Admin ----- */
router.get('/admin', can('review:read'), adminListReviews);
router.patch('/admin/:id/status', can('review:moderate'), setReviewStatus);
router.post('/admin/:id/reply', can('review:reply'), replyReview);
router.delete('/admin/:id', can('review:delete'), adminDeleteReview);

export default router;