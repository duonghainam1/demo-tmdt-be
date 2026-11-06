import mongoose from 'mongoose';
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: '',
    },

    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Categorys',
      default: null,
    },

    image: {
      url: {
        type: String,
        default: '',
      },
      publicId: {
        type: String,
        default: '',
      },
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

categorySchema.index({ parent: 1 });
categorySchema.index({ isActive: 1 });

const Categorys = mongoose.model('Categorys', categorySchema);

export default Categorys;