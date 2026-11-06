// import mongoose from 'mongoose';
// import ProductVariants from '../../models/products/productVariantModel.js';
// import Products from '../../models/products/productModel.js';
// import Prices from '../../models/products/priceModel.js';

// const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
// const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// // undefined -> undefined (không đổi), null/'' -> null, còn lại ép về Number
// const toNumberOrNull = (v) => {
//   if (v === undefined) return undefined;
//   if (v === null || v === '') return null;
//   return Number(v);
// };

// const isBadMoney = (v) => v == null || Number.isNaN(Number(v)) || Number(v) < 0;

// const priceController = {
//   /**
//    * GET /admin/prices
//    * Danh sách biến thể kèm giá theo TỪNG cửa hàng.
//    * Query: page, limit, search (SKU hoặc tên sản phẩm), productId,
//    *        storeId (chỉ lấy biến thể ĐÃ có giá tại cửa hàng này, và chỉ trả giá của cửa hàng đó)
//    */
//   getPriceManagement: async (req, res) => {
//     try {
//       const { page = 1, limit = 20, search = '', productId, storeId } = req.query;

//       const pageNumber = Math.max(Number(page) || 1, 1);
//       const limitNumber = Math.min(Math.max(Number(limit) || 20, 1), 100);
//       const skip = (pageNumber - 1) * limitNumber;

//       if (productId && !isValidId(productId)) {
//         return res.status(400).json({ success: false, message: 'productId không hợp lệ' });
//       }
//       if (storeId && !isValidId(storeId)) {
//         return res.status(400).json({ success: false, message: 'storeId không hợp lệ' });
//       }

//       // Điều kiện dùng chung cho find + count, tránh lệch nhau
//       const query = { isActive: true };
//       if (productId) query.product = productId;

//       if (search) {
//         const re = new RegExp(escapeRegex(search.trim()), 'i');
//         const matchedProducts = await Products.find({ name: re }, '_id').lean();
//         query.$or = [{ sku: re }, { product: { $in: matchedProducts.map((p) => p._id) } }];
//       }

//       if (storeId) {
//         const variantIdsInStore = await Prices.distinct('variant', { store: storeId });
//         query._id = { $in: variantIdsInStore };
//       }

//       const [variants, total] = await Promise.all([
//         ProductVariants.find(query)
//           .populate('product', 'name slug')
//           .sort({ createdAt: -1 })
//           .skip(skip)
//           .limit(limitNumber)
//           .lean(),
//         ProductVariants.countDocuments(query),
//       ]);

//       const variantIds = variants.map((v) => v._id);
//       const priceQuery = { variant: { $in: variantIds } };
//       if (storeId) priceQuery.store = storeId;

//       const prices = await Prices.find(priceQuery).populate('store', 'name code type').lean();

//       const now = new Date();
//       const priceMap = new Map();
//       for (const p of prices) {
//         const key = p.variant.toString();
//         if (!priceMap.has(key)) priceMap.set(key, []);

//         const isSaleActive =
//           p.salePrice != null &&
//           !!p.saleStartDate &&
//           !!p.saleEndDate &&
//           now >= p.saleStartDate &&
//           now <= p.saleEndDate;

//         priceMap.get(key).push({
//           priceId: p._id,
//           store: p.store,
//           price: p.price,
//           compareAtPrice: p.compareAtPrice,
//           costPrice: p.costPrice,
//           salePrice: p.salePrice,
//           saleStartDate: p.saleStartDate,
//           saleEndDate: p.saleEndDate,
//           currency: p.currency,
//           effectivePrice: isSaleActive ? p.salePrice : p.price,
//           isSaleActive,
//           isActive: p.isActive,
//         });
//       }

//       const data = variants.map((v) => ({
//         variantId: v._id,
//         sku: v.sku,
//         product: v.product,
//         attributes: v.attributes,
//         image: v.image,
//         stores: priceMap.get(v._id.toString()) || [], // [] = chưa mở bán ở cửa hàng nào
//       }));

//       return res.status(200).json({
//         success: true,
//         data,
//         pagination: {
//           page: pageNumber,
//           limit: limitNumber,
//           total,
//           totalPages: Math.max(Math.ceil(total / limitNumber), 1),
//         },
//       });
//     } catch (error) {
//       console.error('getPriceManagement:', error);
//       return res.status(500).json({ success: false, message: 'Lỗi server', error: error.message });
//     }
//   },

//   /**
//    * PUT /admin/prices/variants/:variantId/stores/:storeId
//    * Tạo mới hoặc cập nhật giá của 1 biến thể tại 1 cửa hàng (upsert thủ công).
//    * Body: price (bắt buộc), compareAtPrice, costPrice, currency,
//    *       salePrice, saleStartDate, saleEndDate, isActive, note
//    */
//   updateStorePrice: async (req, res) => {
//     try {
//       const { variantId, storeId } = req.params;
//       const { price, compareAtPrice, costPrice, currency, saleStartDate, saleEndDate, isActive, note } = req.body;

//       if (!isValidId(variantId)) {
//         return res.status(400).json({ success: false, message: 'variantId không hợp lệ' });
//       }
//       if (!isValidId(storeId)) {
//         return res.status(400).json({ success: false, message: 'storeId không hợp lệ' });
//       }
//       if (isBadMoney(price)) {
//         return res.status(400).json({ success: false, message: 'price không hợp lệ' });
//       }
//       for (const [field, value] of [['compareAtPrice', compareAtPrice], ['costPrice', costPrice]]) {
//         if (value !== undefined && isBadMoney(value)) {
//           return res.status(400).json({ success: false, message: `${field} không hợp lệ` });
//         }
//       }

//       const salePrice = toNumberOrNull(req.body.salePrice);
//       if (salePrice != null && (Number.isNaN(salePrice) || salePrice < 0)) {
//         return res.status(400).json({ success: false, message: 'salePrice không hợp lệ' });
//       }
//       if (salePrice != null && salePrice > Number(price)) {
//         return res.status(400).json({ success: false, message: 'salePrice không được lớn hơn price' });
//       }
//       if (saleStartDate && saleEndDate && new Date(saleEndDate) <= new Date(saleStartDate)) {
//         return res.status(400).json({ success: false, message: 'saleEndDate phải sau saleStartDate' });
//       }

//       const variant = await ProductVariants.findById(variantId);
//       if (!variant) {
//         return res.status(404).json({ success: false, message: 'Không tìm thấy variant' });
//       }

//       const Stores = mongoose.model('Stores');
//       const store = await Stores.findById(storeId);
//       if (!store) {
//         return res.status(404).json({ success: false, message: 'Không tìm thấy cửa hàng' });
//       }

//       let priceDoc = await Prices.findOne({ variant: variantId, store: storeId });

//       /* ----- Chưa có giá tại cửa hàng này -> tạo mới ----- */
//       if (!priceDoc) {
//         const newCompare = compareAtPrice !== undefined ? Number(compareAtPrice) : 0;
//         const newCost = costPrice !== undefined ? Number(costPrice) : 0;

//         priceDoc = await Prices.create({
//           variant: variantId,
//           product: variant.product,
//           store: storeId,
//           price: Number(price),
//           compareAtPrice: newCompare,
//           costPrice: newCost,
//           currency: currency || 'VND',
//           salePrice: salePrice ?? null,
//           saleStartDate: saleStartDate || null,
//           saleEndDate: saleEndDate || null,
//           isActive: typeof isActive === 'boolean' ? isActive : true,
//           history: [
//             {
//               price: Number(price),
//               compareAtPrice: newCompare,
//               costPrice: newCost,
//               salePrice: salePrice ?? null,
//               note: note || 'Khởi tạo giá cửa hàng',
//               changedAt: new Date(),
//             },
//           ],
//         });

//         return res.status(201).json({
//           success: true,
//           message: 'Thêm giá cho cửa hàng thành công',
//           data: priceDoc,
//         });
//       }

//       /* ----- Đã có -> lưu giá CŨ vào history rồi cập nhật ----- */
//       priceDoc.history.push({
//         price: priceDoc.price,
//         compareAtPrice: priceDoc.compareAtPrice,
//         costPrice: priceDoc.costPrice,
//         salePrice: priceDoc.salePrice,
//         note: note || 'Cập nhật giá cửa hàng',
//         changedAt: new Date(),
//       });

//       priceDoc.price = Number(price);
//       if (compareAtPrice !== undefined) priceDoc.compareAtPrice = Number(compareAtPrice);
//       if (costPrice !== undefined) priceDoc.costPrice = Number(costPrice);
//       if (currency !== undefined) priceDoc.currency = currency;
//       if (salePrice !== undefined) priceDoc.salePrice = salePrice;
//       if (saleStartDate !== undefined) priceDoc.saleStartDate = saleStartDate || null;
//       if (saleEndDate !== undefined) priceDoc.saleEndDate = saleEndDate || null;
//       if (typeof isActive === 'boolean') priceDoc.isActive = isActive;

//       await priceDoc.save();

//       return res.status(200).json({
//         success: true,
//         message: 'Cập nhật giá cửa hàng thành công',
//         data: priceDoc,
//       });
//     } catch (error) {
//       console.error('updateStorePrice:', error);

//       if (error.code === 11000) {
//         return res.status(409).json({ success: false, message: 'SKU này đã có giá tại cửa hàng' });
//       }

//       return res.status(500).json({
//         success: false,
//         message: 'Lỗi cập nhật giá cửa hàng',
//         error: error.message,
//       });
//     }
//   },
// };

// export default priceController;