import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/\S+@\S+\.\S+/, "is invalid"],
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },

    // Tham chiếu tới model Role
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
      index: true,
    },

    avatar: {
      type: String,
      default:
        "https://i.pinimg.com/736x/df/3f/5d/df3f5d635fdce114319c58e09b387ba6.jpg",
    },
    avatarPublicId: { type: String, default: "" },

    phone: {
      type: String,
      trim: true,
      default: "",
      match: [/^(0|\+84)\d{9}$/, "Phone number is invalid"],
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: ["male", "female", "other"],
      default: "male",
    },

    isOnline: {
      type: Boolean,
      default: false,
      index: true,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true, versionKey: false }
);

const Users = mongoose.model("Users", userSchema);

export default Users;