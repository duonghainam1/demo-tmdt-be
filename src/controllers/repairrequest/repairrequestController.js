import mongoose from "mongoose";
import RepairRequest, {
    REQUEST_PAGE_STATUSES,
    MANAGEMENT_PAGE_STATUSES,
    REQUEST_TYPES,
    PRIORITIES,
    TECHNICIAN_ROLE_CODES,
    MAX_WARRANTY_MONTHS,
    SERVICE_MODES,
} from "../../models/repairr/repairrequestMode.js";
import Users from "../../models/users/userModel.js"; // chỉnh lại đường dẫn/tên file cho đúng project
import Role from "../../models/role/roleModel.js"; // chỉnh lại đường dẫn/tên file cho đúng project (model Role có code, isActive)
import {
    getPartOptions as findPartOptions,
    applyCostBreakdown,
    deductParts,
    restoreParts,
} from "../../services/repair/repairPartsService.js"; // chỉnh lại đường dẫn cho đúng chỗ bạn đặt file

/* =====================================================================================
 *  HÀM PHỤ DÙNG CHUNG CHO CẢ 2 PHẦN
 * ===================================================================================== */

// Giả định middleware xác thực gắn user vào req.user (có _id hoặc id)
const getUserId = (req) => req.user?._id || req.user?.id;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getPaging = (query, defaultLimit = 8) => {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), 50);
    return { page, limit, skip: (page - 1) * limit };
};

// Parse ngày: trả về Date hợp lệ, hoặc null nếu sai định dạng
const parseDate = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

// Chuẩn hóa SĐT để so sánh: "+84905123456" và "0905 123 456" -> "0905123456"
const normalizePhone = (p) => String(p || "").replace(/[\s.]/g, "").replace(/^\+84/, "0");

// Số tháng bảo hành: số nguyên 0..60, sai thì trả về null
const parseWarrantyMonths = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= MAX_WARRANTY_MONTHS ? n : null;
};

// Tách mã cần tra cứu từ ô nhập của khách: chấp nhận mã tem (SC-...), IMEI/Serial,
// hoặc cả đường dẫn khi quét QR (lấy tham số ?code=... hoặc đoạn cuối của đường dẫn).
// Trả về chuỗi rỗng nếu không hợp lệ.
const extractWarrantyCode = (raw) => {
    let s = String(raw || "").trim();
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            s =
                u.searchParams.get("code") ||
                u.searchParams.get("c") ||
                u.pathname.split("/").filter(Boolean).pop() ||
                "";
        } catch {
            return "";
        }
    }
    s = s.trim();
    return /^[A-Za-z0-9-]{6,40}$/.test(s) ? s : "";
};

// Che bớt IMEI/Serial khi trả ra công khai: chỉ hiện 4 ký tự cuối
const maskSerial = (s) => (s ? `${"•".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : "");

// IMEI/Serial: bỏ khoảng trắng, viết hoa, kiểm tra quy tắc giống lúc khách gửi yêu cầu.
// Trả về { value } nếu hợp lệ (value có thể là chuỗi rỗng để xóa), hoặc { error } nếu sai.
const parseSerial = (raw) => {
    const s = String(raw ?? "").replace(/\s/g, "").toUpperCase();
    if (s && !/^[A-Z0-9-]{6,40}$/.test(s)) {
        return { error: "IMEI/Serial chỉ gồm chữ, số, dấu gạch ngang (6 đến 40 ký tự)" };
    }
    return { value: s };
};

// Phụ kiện đi kèm: cắt khoảng trắng, rỗng thì trả về undefined (xóa trường)
const parseAccessories = (raw) => String(raw ?? "").trim() || undefined;

// Lỗi validate của mongoose -> 400, còn lại -> 500
const handleError = (res, error) => {
    // Lỗi nghiệp vụ tự ném ra (vd: linh kiện không đủ tồn kho)
    if (error.isBusiness) {
        return res.status(400).json({ message: error.message });
    }
    if (error.name === "ValidationError") {
        const errors = Object.values(error.errors).map((e) => e.message);
        return res.status(400).json({ message: errors[0], errors });
    }
    if (error.name === "CastError") {
        return res.status(400).json({ message: "Dữ liệu không hợp lệ" });
    }
    // Lỗi do pre('save') ném ra khi chuyển trạng thái sai luồng
    if (error.message?.startsWith("Không thể chuyển trạng thái")) {
        return res.status(400).json({ message: error.message });
    }
    console.log(error);
    return res.status(500).json({ message: "Lỗi server" });
};

// Trường được trả ra cho tra cứu công khai: KHÔNG gồm ghi chú nội bộ, email, địa chỉ, SĐT/tên khách,
// và không lộ id người thao tác trong lịch sử.
const PUBLIC_TRACK_FIELDS = [
    "requestCode title device description status serviceMode",
    "preferredVisitAt appointmentDate expectedCompletionDate completedAt",
    "assignedTo diagnosis solution estimatedCost finalCost isPaid cancelReason createdAt",
    "accessories", // phụ kiện đi kèm
    "warrantyMonths warrantyExpiresAt underWarranty warrantyOf", // bảo hành sau sửa chữa
    "statusHistory.status statusHistory.changedAt",
].join(" ");

// Tạo bảng thống kê số lượng theo nhóm trạng thái cho các thẻ đầu trang
// (aggregate không đi qua middleware find nên phải tự loại bản ghi đã xóa)
const buildStats = async (statuses) => {
    const rows = await RepairRequest.aggregate([
        { $match: { status: { $in: statuses }, isDeleted: { $ne: true } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const stats = { all: 0 };
    statuses.forEach((s) => (stats[s] = 0));
    rows.forEach((r) => {
        stats[r._id] = r.count;
        stats.all += r.count;
    });
    return stats;
};

// Tổng chi phí theo bộ lọc hiện tại (toàn bộ các trang, không chỉ trang đang xem).
// - Dùng finalCost (chi phí thực tế). Đơn chưa có chi phí thực tế tính là 0.
// - Bỏ qua đơn đã hủy.
// - partsCost = tổng (số lượng x đơn giá) các linh kiện, laborCost = tổng tiền công.
// - aggregate không tự cast kiểu và không đi qua middleware find nên:
//   + filter phải chứa sẵn ObjectId / Date (đã xử lý ở getManagedRequests)
//   + phải tự loại bản ghi đã xóa mềm
const buildCostSummary = async (filter) => {
    const [row] = await RepairRequest.aggregate([
        {
            $match: {
                $and: [filter, { status: { $ne: "cancelled" } }, { isDeleted: { $ne: true } }],
            },
        },
        {
            $group: {
                _id: null,
                totalCost: { $sum: "$finalCost" },
                paidCost: { $sum: { $cond: ["$isPaid", "$finalCost", 0] } },
                unpaidCost: { $sum: { $cond: ["$isPaid", 0, "$finalCost"] } },
                laborCost: { $sum: { $ifNull: ["$laborCost", 0] } },
                // $sum trong $group không đi vào mảng nên phải cộng từng dòng linh kiện bằng $reduce
                partsCost: {
                    $sum: {
                        $reduce: {
                            input: { $ifNull: ["$parts", []] },
                            initialValue: 0,
                            in: { $add: ["$$value", { $multiply: ["$$this.quantity", "$$this.unitPrice"] }] },
                        },
                    },
                },
            },
        },
    ]);
    return {
        totalCost: row?.totalCost || 0,
        paidCost: row?.paidCost || 0,
        unpaidCost: row?.unpaidCost || 0,
        partsCost: row?.partsCost || 0,
        laborCost: row?.laborCost || 0,
    };
};

// Tách chuỗi "a,b,c" thành mảng và chỉ giữ giá trị nằm trong danh sách cho phép
const parseStatusFilter = (raw, allowed) =>
    raw
        ? String(raw)
              .split(",")
              .map((s) => s.trim())
              .filter((s) => allowed.includes(s))
        : [];

const repairrequestController = {
    /* =================================================================================
     *  ██████████████████████████████████████████████████████████████████████████████
     *  PHẦN 1: YÊU CẦU SỬA CHỮA (GIAI ĐOẠN TIẾP NHẬN)
     *  Trang admin "Yêu cầu sửa chữa": chỉ quản lý trạng thái pending và rejected.
     *  Gồm: khách gửi/xem/tra cứu yêu cầu + admin xem, xác nhận, từ chối.
     *  ██████████████████████████████████████████████████████████████████████████████
     * ================================================================================= */

    // ===================== 1A. KHÁCH HÀNG =====================

    // POST /api/repair-requests  - khách gửi yêu cầu sửa chữa
    createRepairRequest: async (req, res) => {
        try {
            const userId = getUserId(req);
            const {
                customerName,
                phone,
                email,
                address,
                requestType,
                title,
                description,
                device,
                serialNumber,
                images,
                preferredVisitAt,
                warrantyOfCode, // mã đơn sửa chữa gốc (SC-...) nếu đây là yêu cầu bảo hành
                serviceMode, // hình thức sửa chữa: in_store (tại cửa hàng) | on_site (tận nơi)
            } = req.body;

            // Hình thức sửa chữa: không gửi thì mặc định tại cửa hàng, gửi sai thì báo lỗi
            if (serviceMode !== undefined && serviceMode !== "" && !SERVICE_MODES.includes(serviceMode)) {
                return res.status(400).json({ message: "Loại hình sửa chữa không hợp lệ" });
            }
            const finalServiceMode = serviceMode || "in_store";

            // Nếu khách không nhập thông tin liên hệ thì lấy từ tài khoản
            let contact = { customerName, phone, email, address };
            if (userId && (!customerName || !phone)) {
                const user = await Users.findById(userId).select("name phone email");
                if (user) {
                    contact = {
                        customerName: customerName || user.name,
                        phone: phone || user.phone,
                        email: email || user.email,
                        address,
                    };
                }
            }

            // IMEI/Serial do khách nhập khi gửi yêu cầu: chuẩn hóa (chữ hoa, bỏ khoảng trắng) để tra cứu và in tem
            const parsedSerial = parseSerial(serialNumber);
            if (parsedSerial.error) {
                return res.status(400).json({ message: parsedSerial.error });
            }
            const cleanSerial = parsedSerial.value;

            // ----- Yêu cầu bảo hành: gắn với đơn sửa chữa gốc -----
            let warranty = {};
            let originalAddress = ""; // yêu cầu bảo hành không nhập địa chỉ thì lấy lại từ đơn gốc
            if (warrantyOfCode) {
                const original = await RepairRequest.findOne({
                    requestCode: String(warrantyOfCode).trim().toUpperCase(),
                });
                if (!original || original.status !== "completed") {
                    return res
                        .status(400)
                        .json({ message: "Không tìm thấy đơn sửa chữa đã hoàn thành để bảo hành" });
                }

                // Chỉ chủ đơn mới được gửi yêu cầu bảo hành: đúng tài khoản hoặc đúng SĐT đã dùng khi sửa
                const isOwner =
                    (userId && original.customer && String(original.customer) === String(userId)) ||
                    (contact.phone && normalizePhone(contact.phone) === normalizePhone(original.phone));
                if (!isOwner) {
                    return res.status(403).json({ message: "Đơn sửa chữa này không thuộc về bạn" });
                }

                originalAddress = original.address || "";
                warranty = {
                    requestType: "warranty",
                    warrantyOf: original._id,
                    underWarranty: Boolean(original.warrantyExpiresAt && original.warrantyExpiresAt >= new Date()),
                    // Khách không cần nhập lại thiết bị
                    device: device || original.device,
                    serialNumber: cleanSerial || original.serialNumber,
                };
            }
            const finalDevice = warranty.device || device;

            // Địa chỉ là bắt buộc (sửa tận nơi cần biết đi đâu, sửa tại cửa hàng cần để liên hệ / giao trả)
            const finalAddress = String(contact.address || "").trim() || originalAddress;
            if (!finalAddress) {
                return res.status(400).json({ message: "Vui lòng nhập địa chỉ" });
            }

            // Chỉ nhận các trường cho phép (khách không được tự đặt status, priority, chi phí...)
            const repairRequest = new RepairRequest({
                ...contact,
                address: finalAddress,
                serviceMode: finalServiceMode,
                customer: userId,
                createdBy: userId,
                requestType,
                // Form của khách không có ô tiêu đề -> tự tạo từ tên thiết bị
                title:
                    title ||
                    (finalDevice
                        ? `${warrantyOfCode ? "Bảo hành" : "Sửa chữa"} ${finalDevice}`
                        : undefined),
                description,
                device,
                serialNumber: cleanSerial || undefined,
                preferredVisitAt: preferredVisitAt || undefined,
                images: Array.isArray(images) ? images : [],
                ...warranty, // ghi đè requestType/device/serialNumber nếu là yêu cầu bảo hành
            });
            repairRequest.$locals.changedBy = userId;

            await repairRequest.save();

            return res.status(201).json({
                message: "Gửi yêu cầu sửa chữa thành công",
                data: repairRequest,
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/my  - khách xem các yêu cầu của mình
    getMyRepairRequests: async (req, res) => {
        try {
            const userId = getUserId(req);
            const { page, limit, skip } = getPaging(req.query, 10);

            const filter = { customer: userId };
            if (req.query.status) filter.status = req.query.status;

            const [data, total] = await Promise.all([
                RepairRequest.find(filter)
                    .select("-internalNote") // ghi chú nội bộ không trả cho khách
                    .populate("assignedTo", "name phone")
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit),
                RepairRequest.countDocuments(filter),
            ]);

            return res.status(200).json({
                data,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 1B. TRA CỨU CÔNG KHAI (không cần đăng nhập) =====================

    // GET /api/repair-requests/track?keyword=SC-20261021-0001
    // GET /api/repair-requests/track?keyword=0905123456
    trackRepairRequests: async (req, res) => {
        try {
            // Bỏ khoảng trắng và dấu chấm: "0905.123.456" -> "0905123456"
            const keyword = String(req.query.keyword || "").trim().replace(/[\s.]/g, "");

            let filter;
            if (/^SC-\d{8}-\d{4,}$/i.test(keyword)) {
                // Tra theo mã yêu cầu (khớp chính xác)
                filter = { requestCode: keyword.toUpperCase() };
            } else if (/^(0|\+84)\d{9}$/.test(keyword)) {
                // Tra theo SĐT (khớp chính xác, chấp nhận cả dạng 0xxx và +84xxx)
                const local = keyword.startsWith("+84") ? `0${keyword.slice(3)}` : keyword;
                filter = { phone: { $in: [local, `+84${local.slice(1)}`] } };
            } else {
                return res.status(400).json({
                    message: "Vui lòng nhập mã yêu cầu (dạng SC-20261021-0001) hoặc số điện thoại hợp lệ",
                });
            }

            const data = await RepairRequest.find(filter)
                .select(PUBLIC_TRACK_FIELDS)
                .populate("assignedTo", "name") // chỉ lấy tên kỹ thuật viên, không lộ SĐT
                .populate("warrantyOf", "requestCode") // yêu cầu bảo hành -> hiện mã đơn gốc
                .sort({ createdAt: -1 })
                .limit(20);

            return res.status(200).json({ data, total: data.length });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/warranty?code=<tem QR | IMEI | Serial | đường dẫn>&phone=<tùy chọn>
    // Tra cứu bảo hành SAU SỬA CHỮA của thiết bị (không cần đăng nhập). Chỉ trả thông tin bảo hành,
    // KHÔNG trả tên, địa chỉ, SĐT, email của khách; IMEI/Serial được che bớt.
    // Nếu khách nhập thêm SĐT thì phải khớp với SĐT đã dùng khi sửa chữa.
    lookupWarranty: async (req, res) => {
        try {
            const code = extractWarrantyCode(req.query.code);
            if (!code) {
                return res.status(400).json({
                    message: "Vui lòng nhập mã tem QR, IMEI hoặc Serial hợp lệ của thiết bị",
                });
            }

            const phone = normalizePhone(req.query.phone);
            if (phone && !/^0\d{9}$/.test(phone)) {
                return res.status(400).json({ message: "Số điện thoại không hợp lệ" });
            }

            const filter = { status: "completed" };
            if (/^SC-\d{8}-\d{4,}$/i.test(code)) {
                filter.requestCode = code.toUpperCase(); // mã tem QR = mã đơn sửa chữa
            } else {
                filter.serialNumber = new RegExp(`^${escapeRegex(code)}$`, "i"); // IMEI/Serial
            }
            if (phone) filter.phone = { $in: [phone, `+84${phone.slice(1)}`] };

            const rows = await RepairRequest.find(filter)
                .select("requestCode requestType title device serialNumber completedAt warrantyMonths warrantyExpiresAt")
                .sort({ completedAt: -1 })
                .limit(10);

            const data = rows.map((r) => ({
                requestCode: r.requestCode,
                requestType: r.requestType,
                title: r.title,
                device: r.device,
                serial: maskSerial(r.serialNumber),
                completedAt: r.completedAt,
                warrantyMonths: r.warrantyMonths,
                warrantyExpiresAt: r.warrantyExpiresAt,
                warrantyActive: r.warrantyActive,
                warrantyDaysLeft: r.warrantyDaysLeft,
            }));

            // Bảo hành hiệu lực của thiết bị = hạn xa nhất trong các lần sửa chữa
            let summary = { status: "none" };
            const withWarranty = rows.filter((r) => r.warrantyExpiresAt);
            if (withWarranty.length) {
                const best = withWarranty.reduce((a, b) => (a.warrantyExpiresAt >= b.warrantyExpiresAt ? a : b));
                summary = {
                    status: best.warrantyActive ? "active" : "expired",
                    expiresAt: best.warrantyExpiresAt,
                    daysLeft: best.warrantyDaysLeft,
                    basedOn: best.requestCode, // mã đơn gốc để gửi yêu cầu bảo hành
                };
            }

            return res.status(200).json({ data, summary });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 1C. ADMIN: TRANG "YÊU CẦU SỬA CHỮA" =====================

    // GET /api/repair-requests?status=pending,rejected&requestType=repair&search=&page=1&limit=8
    getRepairRequests: async (req, res) => {
        try {
            const { status, requestType, search } = req.query;
            const { page, limit, skip } = getPaging(req.query);

            // Trang này chỉ quản lý pending và rejected
            const requested = parseStatusFilter(status, REQUEST_PAGE_STATUSES);

            const filter = {
                status: { $in: requested.length ? requested : REQUEST_PAGE_STATUSES },
            };
            if (requestType && REQUEST_TYPES.includes(requestType)) {
                filter.requestType = requestType;
            }
            if (search && search.trim()) {
                const re = new RegExp(escapeRegex(search.trim()), "i");
                filter.$or = [{ requestCode: re }, { customerName: re }, { phone: re }];
            }

            const [data, total, stats] = await Promise.all([
                RepairRequest.find(filter)
                    .populate("customer", "name avatar")
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit),
                RepairRequest.countDocuments(filter),
                buildStats(REQUEST_PAGE_STATUSES), // thống kê không phụ thuộc bộ lọc
            ]);

            return res.status(200).json({
                data,
                stats,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/:id  (dùng chung cho cả trang Yêu cầu và trang Quản lý)
    getRepairRequestById: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const repairRequest = await RepairRequest.findById(id)
                .populate("customer", "name phone email avatar")
                .populate("assignedTo", "name phone avatar")
                .populate("statusHistory.changedBy", "name")
                .populate("warrantyOf", "requestCode title completedAt warrantyExpiresAt");

            if (!repairRequest) {
                return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            }

            return res.status(200).json({ data: repairRequest });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // PATCH /api/repair-requests/:id/confirm   (pending -> confirmed)
    // body: { priority, appointmentDate, estimatedCost, internalNote }
    // Sau khi xác nhận, yêu cầu chuyển sang trang "Quản lý sửa chữa" (PHẦN 2).
    confirmRepairRequest: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const { priority, appointmentDate, estimatedCost, internalNote } = req.body;

            if (!appointmentDate) {
                return res.status(400).json({ message: "Vui lòng chọn ngày hẹn" });
            }
            const appointment = parseDate(appointmentDate);
            if (!appointment) {
                return res.status(400).json({ message: "Ngày hẹn không hợp lệ" });
            }
            if (priority && !PRIORITIES.includes(priority)) {
                return res.status(400).json({ message: "Mức ưu tiên không hợp lệ" });
            }

            const repairRequest = await RepairRequest.findById(id);
            if (!repairRequest) {
                return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            }
            if (!repairRequest.canTransitionTo("confirmed")) {
                return res
                    .status(400)
                    .json({ message: "Chỉ có thể xác nhận yêu cầu đang chờ tiếp nhận" });
            }

            repairRequest.status = "confirmed";
            repairRequest.appointmentDate = appointment;
            if (priority) repairRequest.priority = priority;
            if (estimatedCost !== undefined && estimatedCost !== "") {
                repairRequest.estimatedCost = Number(estimatedCost);
            }
            if (internalNote !== undefined) repairRequest.internalNote = internalNote;

            repairRequest.$locals.changedBy = getUserId(req);
            repairRequest.$locals.statusNote = "Admin xác nhận yêu cầu";

            await repairRequest.save();

            return res.status(200).json({
                message: "Đã xác nhận yêu cầu sửa chữa",
                data: repairRequest,
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // PATCH /api/repair-requests/:id/reject   (pending -> rejected)
    // body: { reason }
    rejectRepairRequest: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const reason = (req.body.reason || "").trim();
            if (!reason) {
                return res.status(400).json({ message: "Vui lòng nhập lý do từ chối" });
            }

            const repairRequest = await RepairRequest.findById(id);
            if (!repairRequest) {
                return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            }
            if (!repairRequest.canTransitionTo("rejected")) {
                return res
                    .status(400)
                    .json({ message: "Chỉ có thể từ chối yêu cầu đang chờ tiếp nhận" });
            }

            repairRequest.status = "rejected";
            repairRequest.cancelReason = reason;

            repairRequest.$locals.changedBy = getUserId(req);
            repairRequest.$locals.statusNote = reason;

            await repairRequest.save();

            return res.status(200).json({
                message: "Đã từ chối yêu cầu sửa chữa",
                data: repairRequest,
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    /* =================================================================================
     *  ██████████████████████████████████████████████████████████████████████████████
     *  PHẦN 2: QUẢN LÝ SỬA CHỮA (SAU KHI ĐÃ XÁC NHẬN)
     *  Trang admin "Quản lý sửa chữa": confirmed, received, assigned, in_progress,
     *  waiting_parts, repaired, completed, cancelled.
     *  Gồm: danh sách, phân công kỹ thuật viên, đổi trạng thái, cập nhật thông tin,
     *  linh kiện & tiền công, thanh toán, khách đánh giá, xóa mềm.
     *  ██████████████████████████████████████████████████████████████████████████████
     * ================================================================================= */

    // ===================== 2A. DANH SÁCH, KỸ THUẬT VIÊN, LINH KIỆN =====================

    // GET /api/repair-requests/manage?status=&requestType=&serviceMode=&assignedTo=&priority=&search=&dateFrom=&dateTo=&page=&limit=
    // dateFrom / dateTo: ISO string, lọc theo NGÀY TẠO ĐƠN (createdAt), gồm cả hai đầu mốc.
    // serviceMode: in_store | on_site (đơn cũ chưa có trường này được tính là in_store).
    // Trả thêm `summary` = { totalCost, paidCost, unpaidCost, partsCost, laborCost }
    // của TẤT CẢ đơn khớp bộ lọc (không tính đơn đã hủy).
    getManagedRequests: async (req, res) => {
        try {
            const { status, requestType, assignedTo, priority, search, dateFrom, dateTo, serviceMode } = req.query;
            const { page, limit, skip } = getPaging(req.query);

            const requested = parseStatusFilter(status, MANAGEMENT_PAGE_STATUSES);

            const filter = {
                status: { $in: requested.length ? requested : MANAGEMENT_PAGE_STATUSES },
            };
            if (requestType && REQUEST_TYPES.includes(requestType)) filter.requestType = requestType;
            if (priority && PRIORITIES.includes(priority)) filter.priority = priority;
            // Đơn cũ chưa có serviceMode được coi là sửa tại cửa hàng nên "in_store" phải gồm cả đơn thiếu trường này
            if (serviceMode && SERVICE_MODES.includes(serviceMode)) {
                filter.serviceMode = serviceMode === "in_store" ? { $in: ["in_store", null] } : serviceMode;
            }
            // Phải ép sang ObjectId vì aggregate không tự cast kiểu như find()
            if (assignedTo && mongoose.isValidObjectId(assignedTo)) {
                filter.assignedTo = new mongoose.Types.ObjectId(assignedTo);
            }

            // ----- Lọc theo ngày tạo đơn -----
            const from = dateFrom ? parseDate(dateFrom) : null;
            const to = dateTo ? parseDate(dateTo) : null;
            if (dateFrom && !from) {
                return res.status(400).json({ message: "Ngày bắt đầu không hợp lệ" });
            }
            if (dateTo && !to) {
                return res.status(400).json({ message: "Ngày kết thúc không hợp lệ" });
            }
            if (from && to && from > to) {
                return res.status(400).json({ message: "Ngày bắt đầu phải trước ngày kết thúc" });
            }
            if (from || to) {
                filter.createdAt = {};
                if (from) filter.createdAt.$gte = from;
                if (to) filter.createdAt.$lte = to;
            }

            if (search && search.trim()) {
                const re = new RegExp(escapeRegex(search.trim()), "i");
                filter.$or = [
                    { requestCode: re },
                    { customerName: re },
                    { phone: re },
                    { device: re },
                ];
            }

            const [data, total, stats, summary] = await Promise.all([
                RepairRequest.find(filter)
                    .populate("customer", "name avatar")
                    .populate("assignedTo", "name phone avatar")
                    .populate("warrantyOf", "requestCode")
                    .sort({ updatedAt: -1 })
                    .skip(skip)
                    .limit(limit),
                RepairRequest.countDocuments(filter),
                buildStats(MANAGEMENT_PAGE_STATUSES), // thống kê không phụ thuộc bộ lọc
                buildCostSummary(filter), // tổng chi phí theo bộ lọc hiện tại
            ]);

            return res.status(200).json({
                data,
                stats,
                summary,
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/technicians  - danh sách kỹ thuật viên để chọn khi phân công
    getTechnicians: async (req, res) => {
        try {
            const roles = await Role.find({
                code: { $in: TECHNICIAN_ROLE_CODES },
                isActive: true,
            }).select("_id");

            const data = await Users.find({ role: { $in: roles.map((r) => r._id) } })
                .select("name phone email avatar")
                .sort({ name: 1 });

            return res.status(200).json({ data });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/parts?search=&category=&limit=20
    // Danh sách linh kiện trong kho để chọn: [{ value (variantId), label, sku, price, stock }]
    getPartOptions: async (req, res) => {
        try {
            const data = await findPartOptions({
                search: req.query.search,
                category: req.query.category,
                limit: req.query.limit,
            });
            return res.status(200).json({ data });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2B. PHÂN CÔNG =====================

    // PATCH /api/repair-requests/:id/assign
    // body: { technicianId, expectedCompletionDate }
    // - confirmed           -> assigned (phân công lần đầu)
    // - assigned/in_progress/waiting_parts/repaired -> giữ nguyên trạng thái, chỉ đổi kỹ thuật viên
    assignTechnician: async (req, res) => {
        try {
            const { id } = req.params;
            const { technicianId, expectedCompletionDate } = req.body;
            if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(technicianId)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            let expected;
            if (expectedCompletionDate) {
                expected = parseDate(expectedCompletionDate);
                if (!expected) {
                    return res.status(400).json({ message: "Ngày dự kiến hoàn thành không hợp lệ" });
                }
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });

            const isFirstAssign = doc.canTransitionTo("assigned");
            const isReassign = ["assigned", "in_progress", "waiting_parts", "repaired"].includes(doc.status);
            if (!isFirstAssign && !isReassign) {
                return res.status(400).json({
                    message: "Chỉ có thể phân công yêu cầu đã xác nhận hoặc đang xử lý",
                });
            }

            doc.assignedTo = technicianId; // validator của model kiểm tra là nhân viên đang hoạt động
            if (expected) doc.expectedCompletionDate = expected;

            if (isFirstAssign) {
                doc.status = "assigned";
                doc.$locals.changedBy = getUserId(req);
                doc.$locals.statusNote = "Phân công kỹ thuật viên";
            }

            await doc.save();
            await doc.populate("assignedTo", "name phone avatar");

            return res.status(200).json({
                message: isFirstAssign ? "Đã phân công kỹ thuật viên" : "Đã đổi kỹ thuật viên",
                data: doc,
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2C. ĐỔI TRẠNG THÁI =====================

    // PATCH /api/repair-requests/:id/status
    // body: { status, note, diagnosis, solution, finalCost, reason, laborCost, parts, serialNumber, accessories, internalNote, isPaid }
    // status hợp lệ: received | in_progress | waiting_parts | repaired | completed | cancelled
    // (assigned đi qua /assign, confirmed/rejected đi qua PHẦN 1)
    //
    // - laborCost + parts (tùy chọn): lưu kèm lúc đổi trạng thái; finalCost tự tính lại ở BE.
    // - serialNumber (tùy chọn): IMEI/Serial nhập lúc nhận máy, được chuẩn hóa và kiểm tra.
    // - accessories (tùy chọn): phụ kiện đi kèm nhập lúc nhận máy.
    // - repaired: bắt buộc có chẩn đoán, cách xử lý và chi phí thực tế.
    // - completed: HOÀN THÀNH = ĐÃ THANH TOÁN. Bắt buộc isPaid === true (trừ đơn bảo hành còn hạn miễn phí),
    //   BE tự đánh dấu isPaid và paidAt (model gán paidAt).
    // - Chuyển sang completed: xuất kho các linh kiện đã chọn (chỉ xuất 1 lần, có cờ stockDeducted).
    updateRepairStatus: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const { status, note, diagnosis, solution, finalCost, reason } = req.body;
            const MANUAL_STATUSES = ["received", "in_progress", "waiting_parts", "repaired", "completed", "cancelled"];
            if (!MANUAL_STATUSES.includes(status)) {
                return res.status(400).json({ message: "Trạng thái không hợp lệ" });
            }

            // Kiểm tra IMEI/Serial sớm, trước khi đụng tới đơn / kho
            let serialValue; // undefined = không gửi lên, không đổi
            if (req.body.serialNumber !== undefined) {
                const parsedSerial = parseSerial(req.body.serialNumber);
                if (parsedSerial.error) {
                    return res.status(400).json({ message: parsedSerial.error });
                }
                serialValue = parsedSerial.value;
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            if (!doc.canTransitionTo(status)) {
                return res.status(400).json({
                    message: `Không thể chuyển từ "${doc.status}" sang "${status}"`,
                });
            }

            if (status === "cancelled") {
                const cancelReason = (reason || "").trim();
                if (!cancelReason) {
                    return res.status(400).json({ message: "Vui lòng nhập lý do hủy" });
                }
                doc.cancelReason = cancelReason;
            }

            // Linh kiện + tiền công gửi kèm (phải gọi TRƯỚC khi đổi doc.status)
            await applyCostBreakdown(doc, req.body);

            doc.status = status;
            if (diagnosis !== undefined) doc.diagnosis = diagnosis;
            if (solution !== undefined) doc.solution = solution;
            if (req.body.internalNote !== undefined) doc.internalNote = req.body.internalNote;
            if (serialValue !== undefined) doc.serialNumber = serialValue || undefined;
            if (req.body.accessories !== undefined) doc.accessories = parseAccessories(req.body.accessories);
            // Có linh kiện / tiền công thì finalCost đã được tự tính, không cho ghi đè bằng số gửi lên
            const hasBreakdown = (doc.parts?.length || 0) > 0 || (doc.laborCost || 0) > 0;
            if (finalCost !== undefined && finalCost !== "" && !hasBreakdown) {
                doc.finalCost = Number(finalCost);
            }

            // Báo đã sửa xong: phải có chẩn đoán + cách xử lý
            if (status === "repaired" && (!doc.diagnosis?.trim() || !doc.solution?.trim())) {
                return res
                    .status(400)
                    .json({ message: "Cần nhập chẩn đoán và cách xử lý trước khi báo đã sửa xong" });
            }

            // Đã sửa xong / hoàn thành thì phải có chi phí thực tế (trừ yêu cầu bảo hành còn hạn, được miễn phí)
            if (["repaired", "completed"].includes(status) && !(doc.finalCost > 0) && !doc.underWarranty) {
                return res
                    .status(400)
                    .json({ message: "Vui lòng nhập chi phí thực tế trước khi báo đã sửa xong" });
            }

            // Hoàn thành = đã thanh toán xong. Đơn bảo hành còn hạn có chi phí 0 thì được miễn.
            if (status === "completed") {
                const isFree = !(doc.finalCost > 0) && doc.underWarranty;
                if (!isFree && req.body.isPaid !== true) {
                    return res
                        .status(400)
                        .json({ message: "Cần thanh toán xong trước khi hoàn thành đơn" });
                }
                doc.isPaid = true; // pre('save') của model tự gán paidAt
            }

            doc.$locals.changedBy = getUserId(req);
            doc.$locals.statusNote =
                note || reason || (status === "received" ? "Đã tiếp nhận máy từ khách" : "");

            // Hoàn thành: xuất kho linh kiện. Nếu lưu đơn lỗi sau đó thì hoàn kho lại.
            let stockCtx = null;
            if (status === "completed" && doc.parts?.length > 0 && !doc.stockDeducted) {
                stockCtx = await deductParts(doc, getUserId(req));
                doc.stockDeducted = true;
            }

            // Chuyển sang in_progress/waiting_parts/repaired/completed mà chưa có kỹ thuật viên
            // -> model tự báo lỗi "Cần chọn kỹ thuật viên cho trạng thái này"
            try {
                await doc.save();
            } catch (err) {
                await restoreParts(stockCtx);
                throw err;
            }
            await doc.populate("assignedTo", "name phone avatar");

            return res.status(200).json({ message: "Đã cập nhật trạng thái", data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2D. CẬP NHẬT THÔNG TIN =====================

    // PATCH /api/repair-requests/:id/update
    // body (tùy chọn): { priority, appointmentDate, expectedCompletionDate, diagnosis, solution,
    //                    estimatedCost, finalCost, internalNote, serialNumber, accessories, warrantyMonths, laborCost, parts }
    updateRepairInfo: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            if (!MANAGEMENT_PAGE_STATUSES.includes(doc.status)) {
                return res.status(400).json({
                    message: "Yêu cầu chưa được xác nhận, hãy xử lý ở trang Yêu cầu sửa chữa",
                });
            }
            if (doc.status === "cancelled") {
                return res.status(400).json({ message: "Yêu cầu đã hủy, không thể chỉnh sửa" });
            }

            const body = req.body;

            if (body.priority !== undefined) {
                if (!PRIORITIES.includes(body.priority)) {
                    return res.status(400).json({ message: "Mức ưu tiên không hợp lệ" });
                }
                doc.priority = body.priority;
            }

            for (const field of ["appointmentDate", "expectedCompletionDate"]) {
                if (body[field] !== undefined && body[field] !== "") {
                    const d = parseDate(body[field]);
                    if (!d) return res.status(400).json({ message: "Ngày không hợp lệ" });
                    doc[field] = d;
                }
            }

            // Đã thanh toán thì khóa chi phí thực tế, tránh đổi doanh thu âm thầm
            if (doc.isPaid && body.finalCost !== undefined && body.finalCost !== "" && Number(body.finalCost) !== doc.finalCost) {
                return res.status(400).json({
                    message: "Đơn đã thanh toán, không thể đổi chi phí thực tế. Hãy bỏ đánh dấu thanh toán trước.",
                });
            }

            for (const field of ["estimatedCost", "finalCost"]) {
                if (body[field] !== undefined && body[field] !== "") {
                    doc[field] = Number(body[field]);
                }
            }

            // Linh kiện + tiền công: BE tự tính lại finalCost (đè lên giá trị FE gửi).
            // Đơn đã hoàn thành / đã xuất kho thì bỏ qua.
            await applyCostBreakdown(doc, body);

            for (const field of ["diagnosis", "solution", "internalNote"]) {
                if (body[field] !== undefined) doc[field] = body[field];
            }

            // IMEI/Serial thiết bị: chuẩn hóa + kiểm tra giống lúc khách gửi yêu cầu (gửi rỗng = xóa)
            if (body.serialNumber !== undefined) {
                const parsedSerial = parseSerial(body.serialNumber);
                if (parsedSerial.error) {
                    return res.status(400).json({ message: parsedSerial.error });
                }
                doc.serialNumber = parsedSerial.value || undefined;
            }

            // Phụ kiện đi kèm (gửi rỗng = xóa)
            if (body.accessories !== undefined) {
                doc.accessories = parseAccessories(body.accessories);
            }

            // Bảo hành sau sửa chữa (số tháng). Hạn bảo hành tự tính lại ở model khi đơn đã hoàn thành.
            if (body.warrantyMonths !== undefined && body.warrantyMonths !== "") {
                const months = parseWarrantyMonths(body.warrantyMonths);
                if (months === null) {
                    return res.status(400).json({
                        message: `Số tháng bảo hành phải là số nguyên từ 0 đến ${MAX_WARRANTY_MONTHS}`,
                    });
                }
                doc.warrantyMonths = months;
            }

            await doc.save();
            await doc.populate("assignedTo", "name phone avatar");

            return res.status(200).json({ message: "Đã cập nhật yêu cầu sửa chữa", data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2E. THANH TOÁN =====================

    // PATCH /api/repair-requests/:id/payment
    // body: { isPaid }    (model tự gán / xóa paidAt)
    // Dùng để sửa thanh toán của đơn đã hoàn thành từ trước (đơn mới hoàn thành là đã thanh toán sẵn).
    updatePayment: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }
            if (typeof req.body.isPaid !== "boolean") {
                return res.status(400).json({ message: "isPaid phải là true hoặc false" });
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            if (doc.status !== "completed") {
                return res
                    .status(400)
                    .json({ message: "Chỉ cập nhật thanh toán cho yêu cầu đã hoàn thành" });
            }

            doc.isPaid = req.body.isPaid;
            await doc.save();

            return res.status(200).json({
                message: doc.isPaid ? "Đã đánh dấu đã thanh toán" : "Đã đánh dấu chưa thanh toán",
                data: doc,
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2F. KHÁCH ĐÁNH GIÁ (route chỉ cần đăng nhập) =====================

    // POST /api/repair-requests/:id/rating
    // body: { rating (1-5), feedback }
    rateRepairRequest: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const rating = Number(req.body.rating);
            if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
                return res.status(400).json({ message: "Điểm đánh giá phải từ 1 đến 5" });
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });

            // Chỉ chủ yêu cầu mới được đánh giá
            if (!doc.customer || String(doc.customer) !== String(getUserId(req))) {
                return res.status(403).json({ message: "Bạn không có quyền đánh giá yêu cầu này" });
            }
            if (doc.status !== "completed") {
                return res.status(400).json({ message: "Chỉ đánh giá được yêu cầu đã hoàn thành" });
            }
            if (doc.rating) {
                return res.status(400).json({ message: "Yêu cầu này đã được đánh giá" });
            }

            doc.rating = rating;
            if (req.body.feedback !== undefined) doc.feedback = req.body.feedback;
            await doc.save();

            return res.status(200).json({ message: "Cảm ơn bạn đã đánh giá", data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // ===================== 2G. XÓA MỀM =====================

    // DELETE /api/repair-requests/:id
    // Chỉ xóa được yêu cầu đã kết thúc: completed, cancelled, rejected
    deleteRepairRequest: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: "ID không hợp lệ" });
            }

            const doc = await RepairRequest.findById(id);
            if (!doc) return res.status(404).json({ message: "Không tìm thấy yêu cầu sửa chữa" });
            if (!["completed", "cancelled", "rejected"].includes(doc.status)) {
                return res.status(400).json({
                    message: "Chỉ xóa được yêu cầu đã hoàn thành, đã hủy hoặc đã từ chối",
                });
            }
            // Xóa đơn đã thu tiền sẽ làm doanh thu quá khứ tụt đi
            if (doc.isPaid) {
                return res.status(400).json({ message: "Đơn đã thanh toán, không thể xóa" });
            }

            doc.isDeleted = true;
            await doc.save();

            return res.status(200).json({ message: "Đã xóa yêu cầu sửa chữa" });
        } catch (error) {
            return handleError(res, error);
        }
    },
};

export default repairrequestController;