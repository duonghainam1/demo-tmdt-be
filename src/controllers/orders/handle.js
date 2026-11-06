import { HttpError } from '../../services/cart/cartService.js';

// Bọc controller: trả { success, data } hoặc { success: false, message, code }
export const handle = (fn, successStatus = 200) => async (req, res) => {
  try {
    const data = await fn(req);
    res.status(successStatus).json({ success: true, data });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    }
    // Mongo không hỗ trợ transaction (chạy standalone, không phải replica set)
    if (err?.code === 20 || /Transaction numbers are only allowed/i.test(err?.message || '')) {
      console.error('[order] MongoDB chưa bật replica set:', err.message);
      return res.status(500).json({ success: false, message: 'Hệ thống chưa sẵn sàng xử lý đơn hàng' });
    }
    console.error('[order]', err);
    res.status(500).json({ success: false, message: 'Lỗi hệ thống' });
  }
};