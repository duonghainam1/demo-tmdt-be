// import Stores from "../../models/store/storeModel.js";
// import { escapeRegex } from "../../utils/slugify.js";

// // ==========================================
// // HELPERS
// // ==========================================
// const MAX_DISTANCE_M = 1_000; // 1km, quá xa thì coi như không có cửa hàng gần

// // Chuẩn hóa & validate location. Trả về { value } hoặc { error }
// const parseLocation = (location) => {
//     if (location === undefined) return { value: undefined };

//     const coords = location?.coordinates;
//     if (!Array.isArray(coords) || coords.length !== 2) {
//         return { error: "location.coordinates phải có dạng [lng, lat]" };
//     }

//     const [lng, lat] = coords.map(Number);
//     if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
//         return { error: "location.coordinates phải là số" };
//     }
//     if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
//         return { error: "Kinh độ phải trong [-180, 180], vĩ độ phải trong [-90, 90]" };
//     }

//     return { value: { type: "Point", coordinates: [lng, lat] } };
// };

// const isBoolean = (v) => typeof v === "boolean";

// // Parse query "true"/"false" -> boolean, còn lại -> undefined
// const parseBoolQuery = (v) => {
//     if (v === "true") return true;
//     if (v === "false") return false;
//     return undefined;
// };

// const normalizePhone = (phone) => String(phone ?? "").replace(/\s/g, "");

// const storeController = {
//     // ==========================================
//     // CREATE STORE
//     // ==========================================
//     createStore: async (req, res) => {
//         try {
//             const {
//                 name,
//                 code,
//                 type = "store",
//                 address = {},
//                 location,
//                 phone = "",
//                 email = "",
//                 isSellable = true,
//                 isPickupPoint = true,
//                 isDefault = false,
//                 isActive = true,
//             } = req.body;

//             // Validate
//             if (typeof name !== "string" || !name.trim()) {
//                 return res.status(400).json({
//                     message: "Tên cửa hàng/kho không được để trống",
//                 });
//             }

//             if (typeof code !== "string" || !code.trim()) {
//                 return res.status(400).json({
//                     message: "Mã cửa hàng/kho không được để trống",
//                 });
//             }

//             if (!["store", "warehouse"].includes(type)) {
//                 return res.status(400).json({
//                     message: "type phải là store hoặc warehouse",
//                 });
//             }

//             if (!isBoolean(isSellable) || !isBoolean(isPickupPoint)) {
//                 return res.status(400).json({
//                     message: "isSellable và isPickupPoint phải là boolean",
//                 });
//             }

//             if (isDefault && isActive === false) {
//                 return res.status(400).json({
//                     message: "Cửa hàng mặc định phải đang hoạt động.",
//                 });
//             }

//             const { value: locationValue, error: locationError } = parseLocation(location);
//             if (locationError) {
//                 return res.status(400).json({ message: locationError });
//             }

//             // Chuẩn hóa code
//             const storeCode = code.trim().toUpperCase();

//             // Kiểm tra code tồn tại
//             const existingStore = await Stores.findOne({ code: storeCode });
//             if (existingStore) {
//                 return res.status(400).json({
//                     message: "Mã cửa hàng/kho đã tồn tại",
//                 });
//             }

//             // Nếu là mặc định => bỏ mặc định của store khác
//             if (isDefault) {
//                 await Stores.updateMany(
//                     { isDefault: true },
//                     { $set: { isDefault: false } }
//                 );
//             }

//             // Tạo Store
//             const payload = {
//                 name: name.trim(),
//                 code: storeCode,
//                 type,

//                 address: {
//                     line: address.line || "",
//                     ward: address.ward || "",
//                     city: address.city || "",
//                 },

//                 phone: normalizePhone(phone),
//                 email: String(email || "").trim(),

//                 isSellable,
//                 isPickupPoint,
//                 isDefault,
//                 isActive,
//             };

//             // Không truyền location => model dùng default [0, 0]
//             if (locationValue) payload.location = locationValue;

//             const store = await Stores.create(payload);

//             return res.status(201).json({
//                 message: "Tạo cửa hàng/kho thành công",
//                 data: store,
//             });
//         } catch (error) {
//             console.error("Create store error:", error);

//             if (error.code === 11000) {
//                 return res.status(400).json({
//                     message: "Mã cửa hàng/kho đã tồn tại",
//                 });
//             }

//             if (error.name === "ValidationError") {
//                 return res.status(400).json({ message: error.message });
//             }

//             return res.status(500).json({
//                 message: "Internal server error",
//             });
//         }
//     },

//     // ==========================================
//     // GET STORES
//     // ==========================================
//     getStores: async (req, res) => {
//         try {
//             const {
//                 search,
//                 type,
//                 status,         // "active" | "inactive"
//                 isActive,       // giữ lại để tương thích code cũ: "true" | "false"
//                 isDefault,
//                 isSellable,     // "true" | "false"
//                 isPickupPoint,  // "true" | "false"
//                 page = 1,
//                 limit = 10,
//             } = req.query;

//             const filter = {};

//             // Lọc theo loại
//             if (type !== undefined && type !== "") {
//                 if (!["store", "warehouse"].includes(type)) {
//                     return res.status(400).json({
//                         message: "type phải là store hoặc warehouse",
//                     });
//                 }
//                 filter.type = type;
//             }

//             // Lọc theo trạng thái
//             if (status !== undefined && status !== "") {
//                 if (!["active", "inactive"].includes(status)) {
//                     return res.status(400).json({
//                         message: "status phải là active hoặc inactive",
//                     });
//                 }
//                 filter.isActive = status === "active";
//             } else if (isActive !== undefined && isActive !== "") {
//                 filter.isActive = isActive === "true";
//             }

//             // Lọc mặc định / bán hàng / nhận tại cửa hàng
//             const defaultVal = parseBoolQuery(isDefault);
//             if (defaultVal !== undefined) filter.isDefault = defaultVal;

//             const sellableVal = parseBoolQuery(isSellable);
//             if (sellableVal !== undefined) filter.isSellable = sellableVal;

//             const pickupVal = parseBoolQuery(isPickupPoint);
//             if (pickupVal !== undefined) filter.isPickupPoint = pickupVal;

//             // Tìm kiếm (không phân biệt hoa thường)
//             const keyword = typeof search === "string" ? search.trim() : "";
//             if (keyword) {
//                 const regex = new RegExp(escapeRegex(keyword), "i");
//                 filter.$or = [
//                     { name: regex },
//                     { code: regex },
//                     { "address.line": regex },
//                     { "address.ward": regex },
//                     { "address.city": regex },
//                     { phone: regex },
//                 ];
//             }

//             // Phân trang
//             const pageNum = Math.max(parseInt(page, 10) || 1, 1);
//             const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

//             // Gộp tất cả vào 1 lần truy vấn bằng $facet
//             const [result] = await Stores.aggregate([
//                 {
//                     $facet: {
//                         // Nhánh 1: dữ liệu theo filter hiện tại + phân trang
//                         data: [
//                             { $match: filter },
//                             { $sort: { isDefault: -1, createdAt: -1, _id: -1 } },
//                             { $skip: (pageNum - 1) * limitNum },
//                             { $limit: limitNum },
//                         ],
//                         // Nhánh 2: tổng số bản ghi sau khi áp filter
//                         filteredCount: [
//                             { $match: filter },
//                             { $count: "count" },
//                         ],
//                         // Nhánh 3: thống kê toàn cục, KHÔNG áp filter hiện tại
//                         stats: [
//                             {
//                                 $group: {
//                                     _id: null,
//                                     total: { $sum: 1 },
//                                     active: { $sum: { $cond: ["$isActive", 1, 0] } },
//                                     inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
//                                     warehouse: { $sum: { $cond: [{ $eq: ["$type", "warehouse"] }, 1, 0] } },
//                                     sellable: { $sum: { $cond: ["$isSellable", 1, 0] } },
//                                     pickupPoint: { $sum: { $cond: ["$isPickupPoint", 1, 0] } },
//                                 },
//                             },
//                         ],
//                     },
//                 },
//             ]);

//             const stores = result.data || [];
//             const total = result.filteredCount[0]?.count || 0;
//             const stats = result.stats[0] || {
//                 total: 0,
//                 active: 0,
//                 inactive: 0,
//                 warehouse: 0,
//                 sellable: 0,
//                 pickupPoint: 0,
//             };
//             delete stats._id;

//             return res.status(200).json({
//                 message: "Lấy danh sách cửa hàng/kho thành công",
//                 data: stores,
//                 pagination: {
//                     page: pageNum,
//                     limit: limitNum,
//                     total,
//                     totalPages: Math.ceil(total / limitNum),
//                 },
//                 stats,
//             });
//         } catch (error) {
//             console.error("Get stores error:", error);

//             return res.status(500).json({
//                 message: "Internal server error",
//             });
//         }
//     },

//     // ==========================================
//     // GET NEARBY STORES (tìm cửa hàng gần khách nhất)
//     // GET /stores/nearby?lng=105.8&lat=21.0&maxDistance=10000&pickupOnly=true&limit=10
//     // ==========================================
//     getNearbyStores: async (req, res) => {
//         try {
//             const { lng, lat, maxDistance = 10000, pickupOnly, limit = 10 } = req.query;

//             const lngNum = Number(lng);
//             const latNum = Number(lat);
//             if (
//                 !Number.isFinite(lngNum) || !Number.isFinite(latNum) ||
//                 lngNum < -180 || lngNum > 180 || latNum < -90 || latNum > 90
//             ) {
//                 return res.status(400).json({
//                     message: "lng và lat không hợp lệ",
//                 });
//             }

//             const query = { isActive: true, type: "store", isSellable: true };
//             if (pickupOnly === "true") query.isPickupPoint = true;

//             const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
//             const maxDistanceNum = Math.max(Number(maxDistance) || 10000, 1);

//             const stores = await Stores.aggregate([
//                 {
//                     // $geoNear phải là stage đầu tiên
//                     $geoNear: {
//                         near: { type: "Point", coordinates: [lngNum, latNum] },
//                         distanceField: "distance", // đơn vị: mét
//                         maxDistance: maxDistanceNum,
//                         spherical: true,
//                         query,
//                     },
//                 },
//                 { $limit: limitNum },
//             ]);

//             return res.status(200).json({
//                 message: "Lấy danh sách cửa hàng gần nhất thành công",
//                 data: stores,
//             });
//         } catch (error) {
//             console.error("Get nearby stores error:", error);

//             return res.status(500).json({
//                 message: "Internal server error",
//             });
//         }
//     },

//     // ==========================================
//     // UPDATE STORE
//     // ==========================================
//     updateStore: async (req, res) => {
//         try {
//             const { id } = req.params;
//             const {
//                 name,
//                 code,
//                 type,
//                 address = {},
//                 location,
//                 phone,
//                 email,
//                 isSellable,
//                 isPickupPoint,
//                 isDefault,
//                 isActive,
//             } = req.body;

//             // Kiểm tra tồn tại
//             const store = await Stores.findById(id);
//             if (!store) {
//                 return res.status(404).json({
//                     message: "Không tìm thấy cửa hàng/kho",
//                 });
//             }

//             // Validate
//             if (name !== undefined && (typeof name !== "string" || !name.trim())) {
//                 return res.status(400).json({
//                     message: "Tên cửa hàng/kho không được để trống",
//                 });
//             }

//             if (code !== undefined && (typeof code !== "string" || !code.trim())) {
//                 return res.status(400).json({
//                     message: "Mã cửa hàng/kho không được để trống",
//                 });
//             }

//             if (type !== undefined && !["store", "warehouse"].includes(type)) {
//                 return res.status(400).json({
//                     message: "type phải là store hoặc warehouse",
//                 });
//             }

//             if (isSellable !== undefined && !isBoolean(isSellable)) {
//                 return res.status(400).json({
//                     message: "isSellable phải là boolean",
//                 });
//             }

//             if (isPickupPoint !== undefined && !isBoolean(isPickupPoint)) {
//                 return res.status(400).json({
//                     message: "isPickupPoint phải là boolean",
//                 });
//             }

//             const { value: locationValue, error: locationError } = parseLocation(location);
//             if (locationError) {
//                 return res.status(400).json({ message: locationError });
//             }

//             // Kiểm tra trùng code (nếu có đổi code)
//             let storeCode = store.code;
//             if (code !== undefined) {
//                 storeCode = code.trim().toUpperCase();
//                 if (storeCode !== store.code) {
//                     const existingStore = await Stores.findOne({
//                         code: storeCode,
//                         _id: { $ne: id },
//                     });
//                     if (existingStore) {
//                         return res.status(400).json({
//                             message: "Mã cửa hàng/kho đã tồn tại",
//                         });
//                     }
//                 }
//             }

//             // Ràng buộc với cửa hàng mặc định
//             if (store.isDefault && isDefault === false) {
//                 return res.status(400).json({
//                     message: "Không thể bỏ mặc định trực tiếp. Hãy chọn cửa hàng khác làm mặc định trước.",
//                 });
//             }

//             const willBeDefault = isDefault !== undefined ? isDefault : store.isDefault;
//             if (willBeDefault && isActive === false) {
//                 return res.status(400).json({
//                     message: "Không thể ngừng hoạt động cửa hàng mặc định.",
//                 });
//             }

//             // Nếu set cửa hàng này làm mặc định => bỏ mặc định của cửa hàng khác
//             if (isDefault === true && !store.isDefault) {
//                 await Stores.updateMany(
//                     { isDefault: true, _id: { $ne: id } },
//                     { $set: { isDefault: false } }
//                 );
//             }

//             // Build dữ liệu cập nhật (chỉ set field được truyền lên)
//             const update = {};
//             if (name !== undefined) update.name = name.trim();
//             if (code !== undefined) update.code = storeCode;
//             if (type !== undefined) update.type = type;
//             if (phone !== undefined) update.phone = normalizePhone(phone);
//             if (email !== undefined) update.email = String(email || "").trim();
//             if (isSellable !== undefined) update.isSellable = isSellable;
//             if (isPickupPoint !== undefined) update.isPickupPoint = isPickupPoint;
//             if (isDefault !== undefined) update.isDefault = isDefault;
//             if (isActive !== undefined) update.isActive = willBeDefault ? true : isActive;
//             if (locationValue) update.location = locationValue;

//             if (address && Object.keys(address).length > 0) {
//                 update.address = {
//                     line: address.line !== undefined ? address.line : store.address?.line || "",
//                     ward: address.ward !== undefined ? address.ward : store.address?.ward || "",
//                     city: address.city !== undefined ? address.city : store.address?.city || "",
//                 };
//             }

//             const updatedStore = await Stores.findByIdAndUpdate(id, update, {
//                 new: true,
//                 runValidators: true,
//             });

//             return res.status(200).json({
//                 message: "Cập nhật cửa hàng/kho thành công",
//                 data: updatedStore,
//             });
//         } catch (error) {
//             console.error("Update store error:", error);

//             if (error.code === 11000) {
//                 return res.status(400).json({
//                     message: "Mã cửa hàng/kho đã tồn tại",
//                 });
//             }

//             if (error.name === "CastError") {
//                 return res.status(400).json({
//                     message: "ID cửa hàng/kho không hợp lệ",
//                 });
//             }

//             if (error.name === "ValidationError") {
//                 return res.status(400).json({ message: error.message });
//             }

//             return res.status(500).json({
//                 message: "Internal server error",
//             });
//         }
//     },
//     getNearestStore: async (req, res) => {
//         try {
//             const lat = parseFloat(req.query.lat);
//             const lng = parseFloat(req.query.lng);
//             const limit = Math.min(parseInt(req.query.limit) || 1, 10);

//             // Validate tọa độ
//             if (
//                 Number.isNaN(lat) || Number.isNaN(lng) ||
//                 lat < -90 || lat > 90 || lng < -180 || lng > 180
//             ) {
//                 return res.status(400).json({ message: 'Tọa độ không hợp lệ' });
//             }

//             const stores = await Stores.aggregate([
//                 {
//                     $geoNear: {
//                         near: { type: 'Point', coordinates: [lng, lat] }, // GeoJSON: [lng, lat]
//                         distanceField: 'distance', // mét
//                         maxDistance: MAX_DISTANCE_M,
//                         spherical: true,
//                         query: {
//                             isActive: true,
//                             isSellable: true,
//                             type: 'store', // bỏ qua warehouse
//                         },
//                     },
//                 },
//                 { $limit: limit },
//                 {
//                     $project: {
//                         name: 1,
//                         code: 1,
//                         address: 1,
//                         phone: 1,
//                         location: 1,
//                         isPickupPoint: 1,
//                         distance: 1,
//                         distanceKm: { $round: [{ $divide: ['$distance', 1000] }, 1] },
//                     },
//                 },
//             ]);

//             // Không có cửa hàng trong bán kính -> fallback cửa hàng mặc định
//             if (stores.length === 0) {
//                 const fallback = await Stores.findOne({
//                     isDefault: true,
//                     isActive: true,
//                 }).lean();

//                 return res.json({
//                     data: fallback ? [fallback] : [],
//                     fallback: true,
//                 });
//             }

//             return res.json({ data: stores, fallback: false });
//         } catch (err) {
//             console.error('getNearestStore error:', err);
//             return res.status(500).json({ message: 'Lỗi server' });
//         }
//     },
//     getDefaultStore: async (req, res) => {
//         try {
//             const store = await Stores.findOne({ isDefault: true, isActive: true }).lean();
//             if (!store) return res.status(404).json({ message: 'Chưa có cửa hàng mặc định' });
//             return res.json({ data: store });
//         } catch (err) {
//             return res.status(500).json({ message: 'Lỗi server' });
//         }
//     },
// };

// export default storeController;