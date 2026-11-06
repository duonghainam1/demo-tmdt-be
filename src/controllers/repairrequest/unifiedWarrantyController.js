// controllers/repairrequest/unifiedWarrantyController.js
// Đặt cạnh repairrequestController. Dùng cùng kiểu trả về { data, ... } / { message }.
import { HttpError } from '../../utils/httpError.js';
import { lookupAllWarranties, getMyAllWarranties } from '../../services/warranties/unifiedWarrantyService.js';

const fail = (res, error) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  console.log(error);
  return res.status(500).json({ message: 'Lỗi server' });
};

// GET /api/repair-requests/warranty?code=&phone=   (public)
export const lookupWarranty = async (req, res) => {
  try {
    const result = await lookupAllWarranties({ code: req.query.code, phone: req.query.phone });
    return res.status(200).json(result); // { data: [...], summary: { total, active, expired } }
  } catch (error) {
    return fail(res, error);
  }
};

// GET /api/repair-requests/warranty/my   (cần đăng nhập)
export const getMyWarranties = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const result = await getMyAllWarranties(userId);
    return res.status(200).json(result);
  } catch (error) {
    return fail(res, error);
  }
};