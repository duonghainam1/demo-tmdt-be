import mongoose from 'mongoose';

const flashSaleSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, maxlength: 60 }, // phụ đề hiển thị dưới tiêu đề

    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'active', 'cancelled'],
      default: 'draft',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', default: null },
  },
  { timestamps: true }
);

flashSaleSchema.index({ status: 1, startTime: 1, endTime: 1 });
flashSaleSchema.index({ startTime: 1, endTime: 1 });
flashSaleSchema.index({ code: 1 }, { unique: true, sparse: true });

const FlashSales = mongoose.model('FlashSales', flashSaleSchema);
export default FlashSales;