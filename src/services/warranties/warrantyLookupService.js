// services/warranties/warrantyLookupService.js
// Không có collection riêng: bảo hành được TÍNH LÚC TRA CỨU từ đơn đã hoàn tất.
//   bắt đầu = lúc đơn chuyển sang "completed" (bản ghi completed cuối trong statusHistory)
//   kết thúc = bắt đầu + Products.warrantyMonths
import Orders from '../../models/orders/ordersModel.js';
import Products from '../../models/products/productModel.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Cộng tháng, kẹp ngày cuối tháng (31/01 + 1 tháng = 28/02), hết hạn vào cuối ngày
const addMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  d.setHours(23, 59, 59, 999);
  return d;
};

const getCompletedAt = (order) => {
  const h = [...(order.statusHistory || [])].reverse().find((x) => x.status === 'completed');
  return new Date(h?.changedAt || order.updatedAt || order.createdAt);
};

/** Biến danh sách đơn completed thành danh sách dòng bảo hành. */
export const buildWarranties = async (orders) => {
  const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => String(i.product))))];
  const products = await Products.find({ _id: { $in: productIds } }).select('warrantyMonths').lean();
  const monthsOf = new Map(products.map((p) => [String(p._id), p.warrantyMonths || 0]));

  const now = new Date();
  const result = [];

  for (const order of orders) {
    const startDate = getCompletedAt(order);

    for (const it of order.items) {
      // Ưu tiên số tháng đã chốt lúc đặt hàng (snapshot); đơn cũ chưa có thì lấy theo sản phẩm hiện tại
      const months = it.warrantyMonths ?? (monthsOf.get(String(it.product)) || 0);
      const quantity = it.quantity - (it.returnedQuantity || 0); // hàng đã trả thì không còn bảo hành
      if (months <= 0 || quantity <= 0) continue;

      const endDate = addMonths(startDate, months);
      const active = endDate >= now;

      result.push({
        orderCode: order.code,
        name: it.name,
        image: it.image,
        sku: it.sku,
        attributes: it.attributes,
        quantity,
        warrantyMonths: months,
        startDate,
        endDate,
        status: active ? 'active' : 'expired', // active = còn bảo hành
        remainingDays: active ? Math.ceil((endDate - now) / DAY_MS) : 0,
      });
    }
  }

  // Còn bảo hành lên trước, sắp hết hạn trước; hết hạn xuống cuối
  return result.sort((a, b) =>
    a.status !== b.status ? (a.status === 'active' ? -1 : 1) : a.endDate - b.endDate
  );
};

/** Toàn bộ bảo hành của người dùng. */
export const getMyWarranties = async (userId) => {
  const orders = await Orders.find({ user: userId, status: 'completed' })
    .select('code items statusHistory createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return buildWarranties(orders);
};

/** Bảo hành của 1 đơn (hiện ở trang chi tiết đơn). */
export const getMyWarrantiesByOrder = async (userId, code) => {
  const orders = await Orders.find({ user: userId, code: String(code).toUpperCase(), status: 'completed' })
    .select('code items statusHistory createdAt updatedAt')
    .lean();
  return buildWarranties(orders);
};