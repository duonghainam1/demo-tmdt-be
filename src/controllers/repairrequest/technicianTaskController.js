import mongoose from "mongoose";
import RepairRequest from "../../models/repairr/repairrequestMode.js";
import { applyCostBreakdown } from "../../services/repair/repairPartsService.js"; // chỉnh lại đường dẫn cho đúng chỗ bạn đặt file

/* =====================================================================================
 *  PHẦN 3: CÔNG VIỆC CỦA KỸ THUẬT VIÊN (đơn đã được phân công cho chính mình)
 *  Nguyên tắc: MỌI truy vấn đều ép thêm { assignedTo: userId } nên kỹ thuật viên
 *  không xem/sửa được đơn của người khác (không thấy -> 404, không lộ là đơn có tồn tại).
 *  Kỹ thuật viên KHÔNG được: hủy đơn, đổi kỹ thuật viên, đổi thanh toán, đổi bảo hành,
 *  chuyển sang "Hoàn thành".
 *  Kỹ thuật viên ĐƯỢC: chọn linh kiện + nhập tiền công, báo "Đã sửa xong".
 *  Admin bấm "Hoàn thành" ở trang Quản lý sửa chữa; lúc đó BE mới xuất kho linh kiện (1 lần).
 * ===================================================================================== */

const TASK_STATUSES = ["assigned", "in_progress", "waiting_parts", "repaired", "completed"];
// Kỹ thuật viên dừng ở "repaired"; "completed" do admin xác nhận
const TECH_MANUAL_STATUSES = ["in_progress", "waiting_parts", "repaired"];
const EDITABLE_STATUSES = ["assigned", "in_progress", "waiting_parts", "repaired"];

const getUserId = (req) => req.user?._id || req.user?.id;
// Quyền xem/xử lý đơn của MỌI nhân viên (admin). Role có "*" cũng được.
const canViewAll = (req) => {
    const perms = req.user?.role?.permissions || [];
    return perms.includes("*") || perms.includes("repair:task-all");
};
// Phạm vi truy vấn: có quyền xem tất cả -> không ép assignedTo; còn lại chỉ đơn của chính mình
const scopeOf = (req) => (canViewAll(req) ? {} : { assignedTo: getUserId(req) });

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parseDate = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};
const getPaging = (query, defaultLimit = 8) => {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), 50);
    return { page, limit, skip: (page - 1) * limit };
};
const handleError = (res, error) => {
    // Lỗi nghiệp vụ tự ném ra (vd: linh kiện không đủ tồn kho)
    if (error.isBusiness) {
        return res.status(400).json({ message: error.message });
    }
    if (error.name === "ValidationError") {
        const errors = Object.values(error.errors).map((e) => e.message);
        return res.status(400).json({ message: errors[0], errors });
    }
    if (error.name === "CastError") return res.status(400).json({ message: "Dữ liệu không hợp lệ" });
    if (error.message?.startsWith("Không thể chuyển trạng thái")) {
        return res.status(400).json({ message: error.message });
    }
    console.log(error);
    return res.status(500).json({ message: "Lỗi server" });
};

// aggregate không tự cast ObjectId và không qua middleware find
// assignedTo = null -> thống kê toàn bộ nhân viên
const buildMyStats = async (assignedTo) => {
    const rows = await RepairRequest.aggregate([
        {
            $match: {
                ...(assignedTo ? { assignedTo: new mongoose.Types.ObjectId(String(assignedTo)) } : {}),
                status: { $in: TASK_STATUSES },
                isDeleted: { $ne: true },
            },
        },
        { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const stats = { all: 0 };
    TASK_STATUSES.forEach((s) => (stats[s] = 0));
    rows.forEach((r) => {
        stats[r._id] = r.count;
        stats.all += r.count;
    });
    return stats;
};

// Kỹ thuật viên không được tự đổi đơn giá: linh kiện đã có trong đơn giữ giá đã lưu,
// linh kiện mới để trống để BE lấy giá hiện hành trong kho. Người có quyền xem tất cả (admin) vẫn sửa được giá.
const lockPrices = (req, doc) => {
    if (canViewAll(req) || !Array.isArray(req.body.parts)) return;
    const saved = new Map((doc.parts || []).map((p) => [String(p.variant), p.unitPrice]));
    req.body.parts = req.body.parts.map((p) => ({
        ...p,
        unitPrice: saved.has(String(p.variantId)) ? saved.get(String(p.variantId)) : undefined,
    }));
};

const technicianTaskController = {
    // GET /api/repair-requests/my-tasks?status=&search=&page=&limit=
    getMyTasks: async (req, res) => {
        try {
            const viewAll = canViewAll(req);
            const { status, search, assignedTo } = req.query;
            const { page, limit, skip } = getPaging(req.query);

            const filter = { ...scopeOf(req), status: { $in: TASK_STATUSES } };
            // Người xem tất cả có thể lọc theo 1 kỹ thuật viên: ?assignedTo=<id>
            if (viewAll && assignedTo && mongoose.isValidObjectId(assignedTo)) filter.assignedTo = assignedTo;
            if (status && TASK_STATUSES.includes(status)) filter.status = status;
            if (search && search.trim()) {
                const re = new RegExp(escapeRegex(search.trim()), "i");
                filter.$or = [{ requestCode: re }, { customerName: re }, { phone: re }, { device: re }];
            }

            const [data, total, stats] = await Promise.all([
                RepairRequest.find(filter)
                    .populate("assignedTo", "name phone avatar")
                    .populate("warrantyOf", "requestCode")
                    .sort({ updatedAt: -1 })
                    .skip(skip)
                    .limit(limit),
                RepairRequest.countDocuments(filter),
                buildMyStats(viewAll ? filter.assignedTo || null : getUserId(req)),
            ]);

            return res.status(200).json({
                data,
                stats,
                scope: viewAll ? "all" : "mine", // FE dựa vào đây để hiện cột Kỹ thuật viên
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // GET /api/repair-requests/my-tasks/:id
    getMyTaskById: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

            const doc = await RepairRequest.findOne({ _id: id, ...scopeOf(req) })
                .populate("assignedTo", "name phone avatar")
                .populate("statusHistory.changedBy", "name")
                .populate("warrantyOf", "requestCode title completedAt warrantyExpiresAt");

            if (!doc) return res.status(404).json({ message: "Không tìm thấy công việc" });
            return res.status(200).json({ data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // PATCH /api/repair-requests/my-tasks/:id/status
    // body: { status: in_progress|waiting_parts|repaired, note, diagnosis, solution, finalCost, laborCost, parts }
    // - waiting_parts: bắt buộc ghi chú (đang chờ linh kiện gì)
    // - repaired: bắt buộc có chẩn đoán + cách xử lý + chi phí thực tế
    // - Không có "completed": admin xác nhận hoàn thành và xuất kho ở trang Quản lý sửa chữa
    updateMyTaskStatus: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

            const { status, note, diagnosis, solution, finalCost } = req.body;
            if (!TECH_MANUAL_STATUSES.includes(status)) {
                return res.status(400).json({ message: "Trạng thái không hợp lệ" });
            }

            const doc = await RepairRequest.findOne({ _id: id, ...scopeOf(req) });
            if (!doc) return res.status(404).json({ message: "Không tìm thấy công việc" });
            if (!doc.canTransitionTo(status)) {
                return res.status(400).json({ message: `Không thể chuyển từ "${doc.status}" sang "${status}"` });
            }

            if (diagnosis !== undefined) doc.diagnosis = diagnosis;
            if (solution !== undefined) doc.solution = solution;

            // Linh kiện + tiền công gửi kèm (phải gọi TRƯỚC khi đổi doc.status). Có thì finalCost được tự tính lại.
            lockPrices(req, doc);
            await applyCostBreakdown(doc, req.body);

            // Có linh kiện / tiền công thì finalCost do BE tính, không cho ghi đè bằng số gửi lên
            const hasBreakdown = (doc.parts?.length || 0) > 0 || (doc.laborCost || 0) > 0;
            if (!hasBreakdown && finalCost !== undefined && finalCost !== "" && finalCost !== null) {
                const cost = Number(finalCost);
                if (!Number.isFinite(cost) || cost < 0) {
                    return res.status(400).json({ message: "Chi phí không hợp lệ" });
                }
                doc.finalCost = cost;
            }

            const cleanNote = (note || "").trim();
            if (status === "waiting_parts" && !cleanNote) {
                return res.status(400).json({ message: "Vui lòng ghi rõ linh kiện đang chờ" });
            }
            if (status === "repaired" && (!doc.diagnosis?.trim() || !doc.solution?.trim())) {
                return res
                    .status(400)
                    .json({ message: "Cần nhập chẩn đoán và cách xử lý trước khi báo đã sửa xong" });
            }

            if (status === "repaired" && !(doc.finalCost > 0) && !doc.underWarranty) {
                return res
                    .status(400)
                    .json({ message: "Vui lòng nhập chi phí thực tế trước khi báo đã sửa xong" });
            }

            doc.status = status;
            doc.$locals.changedBy = getUserId(req);
            doc.$locals.statusNote = cleanNote;

            // Không xuất kho ở đây: kho chỉ bị trừ khi admin bấm Hoàn thành (updateRepairStatus)
            await doc.save();
            await doc.populate("assignedTo", "name phone avatar");

            return res.status(200).json({ message: "Đã cập nhật trạng thái", data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },

    // PATCH /api/repair-requests/my-tasks/:id/update
    // body (tùy chọn): { diagnosis, solution, internalNote, serialNumber, accessories, expectedCompletionDate,
    //                    estimatedCost, laborCost, parts: [{ variantId, qty, unitPrice }] }
    updateMyTaskInfo: async (req, res) => {
        try {
            const { id } = req.params;
            if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "ID không hợp lệ" });

            const doc = await RepairRequest.findOne({ _id: id, ...scopeOf(req) });
            if (!doc) return res.status(404).json({ message: "Không tìm thấy công việc" });
            if (!EDITABLE_STATUSES.includes(doc.status)) {
                return res.status(400).json({ message: "Đơn đã kết thúc, không thể chỉnh sửa" });
            }

            const body = req.body;
            for (const field of ["diagnosis", "solution", "internalNote"]) {
                if (body[field] !== undefined) doc[field] = body[field];
            }

            if (body.estimatedCost !== undefined && body.estimatedCost !== "" && body.estimatedCost !== null) {
                const cost = Number(body.estimatedCost);
                if (!Number.isFinite(cost) || cost < 0) {
                    return res.status(400).json({ message: "Chi phí dự kiến không hợp lệ" });
                }
                doc.estimatedCost = cost;
            }

            if (body.expectedCompletionDate) {
                const d = parseDate(body.expectedCompletionDate);
                if (!d) return res.status(400).json({ message: "Ngày dự kiến hoàn thành không hợp lệ" });
                doc.expectedCompletionDate = d;
            }

            if (body.serialNumber !== undefined) {
                const serial = String(body.serialNumber || "").trim().toUpperCase();
                if (serial && !/^[A-Z0-9-]{6,40}$/.test(serial)) {
                    return res.status(400).json({
                        message: "IMEI/Serial chỉ gồm chữ, số, dấu gạch ngang (6 đến 40 ký tự)",
                    });
                }
                doc.serialNumber = serial || undefined;
            }

            // Phụ kiện đi kèm (gửi rỗng = xóa)
            if (body.accessories !== undefined) {
                doc.accessories = String(body.accessories || "").trim() || undefined;
            }

            // Linh kiện + tiền công: BE kiểm tra tồn kho và tự tính lại chi phí thực tế (chưa trừ kho)
             lockPrices(req, doc); // body trỏ cùng object với req.body nên body.parts đã được thay
            await applyCostBreakdown(doc, body);

            await doc.save();
            await doc.populate("assignedTo", "name phone avatar");
            return res.status(200).json({ message: "Đã lưu cập nhật", data: doc });
        } catch (error) {
            return handleError(res, error);
        }
    },
};

export default technicianTaskController;