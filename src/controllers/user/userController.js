import mongoose from "mongoose";
import Users from "../../models/users/userModel.js";
import Orders from "../../models/orders/ordersModel.js";
import Role from "../../models/role/roleModel.js";
import {
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js";

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const userController = {
  // Lấy thông tin cá nhân (req.user đã được populate role trong middleware)
  getUserProfile: async (req, res) => {
    try {
      const user = req.user;
      res.status(200).json({ user });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Lấy danh sách user (phân trang, tìm kiếm, lọc theo role)
  getAllUsers: async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
      const search = (req.query.search || "").trim();
      const { role } = req.query; // ?role=<roleId>

      const filter = {};

      if (search) {
        const keyword = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(keyword, "i");
        filter.$or = [{ name: regex }, { email: regex }, { phone: regex }];
      }

      if (role) {
        if (!isValidId(role)) {
          return res.status(400).json({ message: "Invalid role ID" });
        }
        filter.role = role;
      }

      const [users, totalUsers] = await Promise.all([
        Users.find(filter)
          .select("-password")
          .populate("role", "name code")
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Users.countDocuments(filter),
      ]);

      // Thống kê đơn hàng của các user trong trang này bằng 1 query
      const userIds = users.map((u) => u._id);
      const stats = await Orders.aggregate([
        { $match: { user: { $in: userIds } } },
        {
          $group: {
            _id: "$user",
            orderCount: { $sum: 1 },
            // tổng chi tiêu: bỏ qua đơn đã hủy
            totalSpent: {
              $sum: {
                $cond: [{ $ne: ["$status", "cancelled"] }, "$total", 0],
              },
            },
          },
        },
      ]);

      const statsByUser = new Map(stats.map((s) => [s._id.toString(), s]));

      const usersWithStats = users.map((u) => {
        const s = statsByUser.get(u._id.toString());
        return {
          ...u,
          orderCount: s?.orderCount ?? 0,
          totalSpent: s?.totalSpent ?? 0,
        };
      });

      res.status(200).json({
        users: usersWithStats,
        totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        currentPage: page,
      });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // Cập nhật hồ sơ cá nhân (không cho sửa email, role)
  updateUserProfile: async (req, res) => {
    try {
      const user = req.user;
      const { name, phone, dateOfBirth, gender } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Name is required" });
      }

      if (gender && !["male", "female", "other"].includes(gender)) {
        return res.status(400).json({ message: "Invalid gender" });
      }

      const cleanPhone = phone ? phone.trim() : "";
      if (cleanPhone && !/^(0|\+84)\d{9}$/.test(cleanPhone)) {
        return res.status(400).json({ message: "Phone number is invalid" });
      }

      let parsedDob = null;
      if (dateOfBirth) {
        parsedDob = new Date(dateOfBirth);
        if (isNaN(parsedDob.getTime()) || parsedDob > new Date()) {
          return res.status(400).json({ message: "Date of birth is invalid" });
        }
      }

      let avatar = user.avatar;
      let avatarPublicId = user.avatarPublicId || "";

      if (req.file) {
        const result = await uploadImageToCloudinary(req.file.buffer, "avatars");

        // Xóa ảnh cũ sau khi upload ảnh mới thành công
        if (user.avatarPublicId) {
          await deleteImageFromCloudinary(user.avatarPublicId).catch(() => {});
        }

        avatar = result.secure_url;
        avatarPublicId = result.public_id;
      }

      const updatedUser = await Users.findByIdAndUpdate(
        user._id,
        {
          name: name.trim(),
          avatar,
          avatarPublicId,
          phone: cleanPhone,
          dateOfBirth: parsedDob,
          gender: gender || user.gender,
        },
        { returnDocument: "after", runValidators: true }
      )
        .select("-password")
        .populate("role", "name code permissions");

      return res.status(200).json({
        message: "Profile updated successfully",
        user: updatedUser,
      });
    } catch (error) {
      console.log("Update profile error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  // Đổi role cho user (dành cho admin)
  updateUserRole: async (req, res) => {
    try {
      const { id } = req.params;
      const { roleId } = req.body;

      if (!isValidId(id) || !isValidId(roleId)) {
        return res.status(400).json({ message: "Invalid ID" });
      }

      // Không cho tự đổi role của chính mình
      if (req.user._id.toString() === id) {
        return res
          .status(403)
          .json({ message: "You cannot change your own role" });
      }

      const role = await Role.findById(roleId);
      if (!role || !role.isActive) {
        return res.status(404).json({ message: "Role not found or inactive" });
      }

      const user = await Users.findByIdAndUpdate(
        id,
        { role: role._id },
        { returnDocument: "after", runValidators: true }
      )
        .select("-password")
        .populate("role", "name code");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.status(200).json({ message: "Role updated successfully", user });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: "Internal server error" });
    }
  },
};

export default userController;