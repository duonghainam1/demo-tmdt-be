import mongoose from "mongoose";
import Counter from "./counterModel.js"; // model Counter để sinh mã requestCode

// ===================== HẰNG SỐ (export để service/validation/FE dùng chung) =====================
export const REQUEST_TYPES = ["repair", "maintenance", "warranty", "inspection", "other"];

// Hình thức sửa chữa: khách mang máy đến cửa hàng hoặc kỹ thuật viên đến tận nơi
export const SERVICE_MODES = ["in_store", "on_site"];

export const REQUEST_STATUSES = [
  "pending", // Chờ tiếp nhận
  "confirmed", // Đã xác nhận
  "received", // Đã tiếp nhận máy
  "assigned", // Đã phân công
  "in_progress", // Đang sửa chữa
  "waiting_parts", // Chờ linh kiện
  "repaired", // Đã sửa xong
  "completed", // Hoàn thành
  "cancelled", // Đã hủy
  "rejected", // Từ chối
];

export const PRIORITIES = ["low", "normal", "high", "urgent"];

// Nhóm trạng thái của từng trang quản trị
export const REQUEST_PAGE_STATUSES = ["pending", "rejected"]; // trang "Yêu cầu sửa chữa"
export const MANAGEMENT_PAGE_STATUSES = [
  "confirmed",
  "received",
  "assigned",
  "in_progress",
  "waiting_parts",
  "repaired",
  "completed",
  "cancelled",
]; // trang "Quản lý sửa chữa"

// Trạng thái bắt buộc đã có kỹ thuật viên (received chưa cần: mới nhận máy, chưa giao việc)
export const NEED_TECHNICIAN = ["assigned", "in_progress", "waiting_parts", "repaired", "completed"];
// Trạng thái bắt buộc có lý do
const NEED_REASON = ["rejected", "cancelled"];

// Mã role (Role.code) được phép nhận việc sửa chữa. SỬA lại cho đúng với dữ liệu Role của bạn.
export const TECHNICIAN_ROLE_CODES = ["STAFF", "STAFF_TECHNICIAN"];

// Số tháng bảo hành tối đa sau sửa chữa (0 = không bảo hành)
export const MAX_WARRANTY_MONTHS = 60;

// Tối đa số dòng linh kiện cho mỗi đơn (khớp MAX_PARTS ở repairPartsService)
const MAX_PARTS_PER_REQUEST = 30;

// Luồng chuyển trạng thái hợp lệ
export const STATUS_TRANSITIONS = {
  pending: ["confirmed", "rejected"],
  confirmed: ["received", "assigned", "in_progress", "cancelled"],
  received: ["assigned", "in_progress", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  in_progress: ["waiting_parts", "repaired", "cancelled"],
  waiting_parts: ["in_progress", "repaired", "cancelled"],
  repaired: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: [],
};

// Cộng thêm N tháng, hết hạn vào cuối ngày (23:59:59). Xử lý tháng ngắn: 31/01 + 1 tháng = 28/02
const addMonthsEndOfDay = (date, months) => {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
};

// Kiểm tra user là nhân viên đang hoạt động (role nằm trong TECHNICIAN_ROLE_CODES).
// Lấy model "Users" lúc chạy để tránh import vòng.
const isActiveStaff = async (userId) => {
  const user = await mongoose
    .model("Users")
    .findById(userId)
    .select("role")
    .populate({ path: "role", select: "code isActive" });
  return Boolean(user?.role?.isActive && TECHNICIAN_ROLE_CODES.includes(user.role.code));
};

// ===================== SCHEMA CON =====================
const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    note: { type: String, trim: true, maxlength: 500 },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Một dòng linh kiện đã dùng cho đơn (snapshot lúc lưu, không đổi khi sản phẩm đổi tên/giá)
const partSchema = new mongoose.Schema(
  {
    variant: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariants", required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Products", required: true },
    sku: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    image: { type: String, default: "" }, // URL ảnh linh kiện để FE hiển thị
    quantity: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: "Số lượng phải là số nguyên" } },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// ===================== SCHEMA CHÍNH =====================
const repairRequestSchema = new mongoose.Schema(
  {
    // Mã yêu cầu: SC-20261021-0001 (tự sinh, xem pre('validate'))
    requestCode: { type: String, unique: true, index: true, immutable: true },

    // --- Khách hàng ---
    // Tài khoản khách hàng (User có role Khách hàng). Để trống nếu admin tạo hộ khách vãng lai.
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Users", index: true },
    // Thông tin liên hệ tại thời điểm gửi yêu cầu (lưu lại để không đổi khi khách sửa hồ sơ)
    customerName: {
      type: String,
      required: [true, "Vui lòng nhập tên khách hàng"],
      trim: true,
      maxlength: 100,
    },
    phone: {
      type: String,
      required: [true, "Vui lòng nhập số điện thoại"],
      trim: true,
      match: [/^(0|\+84)\d{9}$/, "Số điện thoại không hợp lệ"], // cùng quy tắc với model Users
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/\S+@\S+\.\S+/, "Email không hợp lệ"],
    },
    // Địa chỉ khách: bắt buộc khi tạo yêu cầu (kiểm tra ở controller, không đặt required ở đây
    // để các đơn cũ chưa có địa chỉ vẫn lưu được)
    address: { type: String, trim: true, maxlength: 300 },

    // --- Nội dung yêu cầu ---
    requestType: { type: String, enum: REQUEST_TYPES, default: "repair", required: true },
    // Hình thức: in_store = sửa tại cửa hàng, on_site = sửa tận nơi (kỹ thuật viên đến địa chỉ khách)
    serviceMode: { type: String, enum: SERVICE_MODES, default: "in_store" },
    title: { type: String, required: [true, "Vui lòng nhập tiêu đề"], trim: true, maxlength: 200 },
    description: {
      type: String,
      required: [true, "Vui lòng mô tả sự cố"],
      trim: true,
      maxlength: 2000,
    },
    device: { type: String, trim: true, maxlength: 200 }, // ví dụ: "Máy giặt Samsung WW90"
    serialNumber: { type: String, trim: true },
    accessories: { type: String, trim: true, maxlength: 500 }, // phụ kiện đi kèm khi nhận máy: sim, ốp lưng...
    preferredVisitAt: { type: Date }, // ngày giờ khách muốn sửa chữa (mang máy đến hoặc hẹn kỹ thuật viên tới)
    images: {
      type: [String], // URL ảnh đính kèm
      validate: [(arr) => arr.length <= 5, "Tối đa 5 ảnh"],
      default: [],
    },

    // --- Trạng thái & ưu tiên ---
    status: { type: String, enum: REQUEST_STATUSES, default: "pending", index: true },
    priority: { type: String, enum: PRIORITIES, default: "normal" },
    statusHistory: { type: [statusHistorySchema], default: [] },

    // --- Lịch ---
    appointmentDate: { type: Date },
    expectedCompletionDate: { type: Date },
    completedAt: { type: Date },

    // --- Xử lý ---
    // Kỹ thuật viên: User có role nằm trong TECHNICIAN_ROLE_CODES
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      index: true,
      required: [
        function () {
          return NEED_TECHNICIAN.includes(this.status);
        },
        "Cần chọn kỹ thuật viên cho trạng thái này",
      ],
      validate: {
        validator: async (v) => (v ? isActiveStaff(v) : true),
        message: "Người được phân công phải là nhân viên đang hoạt động",
      },
    },
    diagnosis: { type: String, trim: true, maxlength: 2000 },
    solution: { type: String, trim: true, maxlength: 2000 },
    internalNote: { type: String, trim: true, maxlength: 2000 },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: 500,
      required: [
        function () {
          return NEED_REASON.includes(this.status);
        },
        "Vui lòng nhập lý do",
      ],
    },

    // --- Linh kiện & tiền công ---
    // parts: snapshot các linh kiện lấy từ kho (xem repairPartsService.buildParts)
    parts: {
      type: [partSchema],
      default: [],
      validate: [(arr) => arr.length <= MAX_PARTS_PER_REQUEST, `Tối đa ${MAX_PARTS_PER_REQUEST} linh kiện cho mỗi đơn`],
    },
    laborCost: { type: Number, min: 0, default: 0 }, // tiền công sửa chữa
    // Đã xuất kho linh kiện chưa (chỉ xuất 1 lần khi chuyển sang completed)
    stockDeducted: { type: Boolean, default: false },

    // --- Bảo hành SAU sửa chữa ---
    // (1) Bảo hành mà đơn NÀY cấp cho khách: admin chọn số tháng khi hoàn thành đơn,
    //     warrantyExpiresAt tự tính từ completedAt (xem middleware pre('save')).
    warrantyMonths: {
      type: Number,
      min: [0, "Số tháng bảo hành không hợp lệ"],
      max: [MAX_WARRANTY_MONTHS, `Bảo hành tối đa ${MAX_WARRANTY_MONTHS} tháng`],
      validate: { validator: Number.isInteger, message: "Số tháng bảo hành phải là số nguyên" },
      default: 0,
    },
    warrantyExpiresAt: { type: Date },
    // (2) Nếu đơn NÀY là yêu cầu bảo hành (requestType = "warranty"): trỏ về đơn sửa chữa gốc
    warrantyOf: { type: mongoose.Schema.Types.ObjectId, ref: "RepairRequest", index: true },
    // Tại thời điểm gửi yêu cầu bảo hành, đơn gốc còn hạn hay không (admin dựa vào đây để miễn phí)
    underWarranty: { type: Boolean, default: false },

    // --- Chi phí & thanh toán ---
    estimatedCost: { type: Number, min: 0, default: 0 },
    finalCost: { type: Number, min: 0, default: 0 }, // = laborCost + Σ(parts) khi có linh kiện / tiền công
    isPaid: { type: Boolean, default: false },
    paidAt: { type: Date },

    // --- Đánh giá của khách sau khi hoàn thành ---
    rating: { type: Number, min: 1, max: 5 },
    feedback: { type: String, trim: true, maxlength: 1000 },

    // --- Hệ thống ---
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" }, // khách tự gửi hoặc admin tạo hộ
    isDeleted: { type: Boolean, default: false, index: true }, // xóa mềm
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

// ===================== INDEX =====================
repairRequestSchema.index({ status: 1, createdAt: -1 }); // lọc theo nhóm trạng thái + mới nhất
repairRequestSchema.index({ assignedTo: 1, status: 1 }); // việc của từng kỹ thuật viên
repairRequestSchema.index({ customer: 1, createdAt: -1 }); // lịch sử yêu cầu của 1 khách
repairRequestSchema.index({ customerName: "text", phone: "text", requestCode: "text", title: "text" });

// ===================== VIRTUAL =====================
repairRequestSchema.virtual("technicianAssigned").get(function () {
  return Boolean(this.assignedTo);
});

// Bảo hành của đơn này còn hạn không
repairRequestSchema.virtual("warrantyActive").get(function () {
  return Boolean(this.warrantyExpiresAt && this.warrantyExpiresAt >= new Date());
});

// Số ngày bảo hành còn lại (0 nếu hết hạn hoặc không có)
repairRequestSchema.virtual("warrantyDaysLeft").get(function () {
  if (!this.warrantyExpiresAt) return 0;
  return Math.max(0, Math.ceil((this.warrantyExpiresAt - new Date()) / 86400000));
});

// ===================== METHOD =====================
// Kiểm tra có được chuyển sang trạng thái mới không
repairRequestSchema.methods.canTransitionTo = function (nextStatus) {
  return (STATUS_TRANSITIONS[this.status] || []).includes(nextStatus);
};

// ===================== MIDDLEWARE =====================
// Lưu trạng thái gốc khi đọc từ DB để so sánh lúc save
repairRequestSchema.post("init", function (doc) {
  doc.$locals.originalStatus = doc.status;
});

// Lưu ý: Mongoose 9 không còn truyền `next` vào middleware.
// Hook bất đồng bộ dùng async/await, muốn báo lỗi thì `throw`.

// 1) Sinh mã yêu cầu bằng bộ đếm nguyên tử (không trùng khi tạo đồng thời)
repairRequestSchema.pre("validate", async function () {
  if (!this.isNew || this.requestCode) return;

  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const seq = await Counter.next(`repairRequest:${ymd}`);
  this.requestCode = `SC-${ymd}-${String(seq).padStart(4, "0")}`;
});

// 2) Kiểm tra luồng trạng thái + ghi lịch sử + các mốc thời gian + hạn bảo hành
// Truyền người thao tác / ghi chú: doc.$locals.changedBy = userId; doc.$locals.statusNote = "..."
repairRequestSchema.pre("save", function () {
  const changedBy = this.$locals.changedBy;
  const note = this.$locals.statusNote || (NEED_REASON.includes(this.status) ? this.cancelReason : "");

  if (this.isNew) {
    this.statusHistory.push({ status: this.status, note: "Tạo yêu cầu", changedBy: changedBy || this.createdBy });
    return;
  }

  if (this.isModified("status")) {
    const from = this.$locals.originalStatus;
    if (from && !(STATUS_TRANSITIONS[from] || []).includes(this.status)) {
      throw new Error(`Không thể chuyển trạng thái từ "${from}" sang "${this.status}"`);
    }
    this.statusHistory.push({ status: this.status, note, changedBy });
    if (this.status === "completed") this.completedAt = new Date();
  }

  // Tính hạn bảo hành: khi vừa hoàn thành, hoặc khi admin đổi số tháng của đơn đã hoàn thành
  if (this.status === "completed" && this.completedAt && (this.isModified("status") || this.isModified("warrantyMonths"))) {
    this.warrantyExpiresAt = this.warrantyMonths > 0 ? addMonthsEndOfDay(this.completedAt, this.warrantyMonths) : undefined;
  }

  if (this.isModified("isPaid") && this.isPaid && !this.paidAt) this.paidAt = new Date();
  if (this.isModified("isPaid") && !this.isPaid) this.paidAt = undefined;
});

// 3) Cập nhật lại trạng thái gốc sau khi lưu (để save nhiều lần trên cùng 1 document vẫn đúng)
repairRequestSchema.post("save", function (doc) {
  doc.$locals.originalStatus = doc.status;
});

// 4) Mặc định bỏ qua bản ghi đã xóa mềm. Muốn lấy cả bản ghi đã xóa: .setOptions({ withDeleted: true })
repairRequestSchema.pre(/^find/, function () {
  if (!this.getOptions().withDeleted) this.where({ isDeleted: { $ne: true } });
});

const RepairRequest = mongoose.model("RepairRequest", repairRequestSchema);

export default RepairRequest;