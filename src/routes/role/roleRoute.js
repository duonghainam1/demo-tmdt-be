import express from 'express';
import roleController from '../../controllers/role/roleController.js';
import authMiddleware, { requireRole } from '../../middlewares/authMiddleware.js';

const router = express.Router();

// Chỉ ADMIN được quản lý vai trò (tránh leo thang đặc quyền)
// router.use(authMiddleware, requireRole('ADMIN'));

router.post('/', roleController.createRole);
router.get('/', roleController.getAllRoles);
router.get('/:id', roleController.getRoleById);
router.put('/:id', roleController.updateRole);
router.delete('/:id', roleController.deleteRole);
router.delete('/:id/users/:userId', roleController.removeUserFromRole);
export default router;