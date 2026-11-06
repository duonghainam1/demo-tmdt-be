// controllers/warranties/warrantyLookupController.js
import * as warrantyService from '../../services/warranties/warrantyLookupService.js';
import { handle } from '../../utils/handle.js';

// Trả mảng: [{ orderCode, name, image, sku, attributes, quantity, warrantyMonths, startDate, endDate, status, remainingDays }]
export const getMyWarranties = handle((req) => warrantyService.getMyWarranties(req.user.id));

export const getMyWarrantiesByOrder = handle((req) =>
  warrantyService.getMyWarrantiesByOrder(req.user.id, req.params.code)
);

// ----- routes (gắn middleware đăng nhập giống route đơn hàng của khách) -----
// router.get('/warranties', auth, getMyWarranties);
// router.get('/warranties/order/:code', auth, getMyWarrantiesByOrder);