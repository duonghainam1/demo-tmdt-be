import mongoose from "mongoose";

/**
 * Bộ đếm tăng dần theo khóa (dùng sinh mã yêu cầu).
 * Dùng $inc nguyên tử nên nhiều request tạo cùng lúc vẫn không trùng mã.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // ví dụ: "repairRequest:20261021"
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

counterSchema.statics.next = async function (key) {
  const counter = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
};

export default mongoose.model("Counter", counterSchema);