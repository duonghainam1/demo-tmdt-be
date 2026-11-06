import { Router } from 'express';
import * as ctrl from '../../controllers/flashSales/flashSaleController.js';
import { loggedIn, requirePermission as need } from '../../middlewares/authMiddleware.js';

/**
 * Mount:
 *   app.use('/api/flash-sales', publicRouter);
 *   app.use('/api/admin/flash-sales', adminRouter);
 */

const publicRouter = Router();
publicRouter.get('/current', ctrl.getCurrent);
publicRouter.get('/:id/products', ctrl.getProducts);

const adminRouter = Router();
adminRouter.use(loggedIn); // đăng nhập một lần cho cả router

adminRouter.get('/', need('promotion:read'), ctrl.list);
adminRouter.post('/', need('promotion:create'), ctrl.create);
adminRouter.get('/:id', need('promotion:read'), ctrl.detail);
adminRouter.patch('/:id', need('promotion:update'), ctrl.update);
adminRouter.post('/:id/publish', need('promotion:update'), ctrl.publish);
adminRouter.post('/:id/cancel', need('promotion:update'), ctrl.cancel);
adminRouter.post('/:id/end-now', need('promotion:update'), ctrl.endNow);

// Danh sách biến thể có thể chọn để thêm vào đợt
adminRouter.get('/:id/available-variants', need('promotion:read'), ctrl.availableVariants);

adminRouter.post('/:id/items', need('promotion:update'), ctrl.addItems);
adminRouter.patch('/:id/items/:itemId', need('promotion:update'), ctrl.updateItem);
adminRouter.delete('/:id/items/:itemId', need('promotion:delete'), ctrl.removeItem);

export default { publicRouter, adminRouter };