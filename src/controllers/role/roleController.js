import mongoose from 'mongoose';
import Role from '../../models/role/roleModel.js';
import Users from '../../models/users/userModel.js'; // chỉnh lại đường dẫn cho đúng dự án

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Các field cho phép client cập nhật (code là immutable nên không có ở đây)
const UPDATABLE_FIELDS = ['name', 'description', 'permissions', 'isActive'];
const DEFAULT_ROLE_CODE = 'USER';
const ADMIN_ROLE_CODE = 'ADMIN';
const MAX_USERS_PER_ROLE = 20; // số tài khoản tối đa trả về trong mỗi vai trò

// Trả lỗi 500 chung, chi tiết lỗi chỉ ghi log ở server
const serverError = (res, error) => {
  console.error(error);
  return res.status(500).json({ success: false, message: 'Lỗi server' });
};

// Trả lỗi validate / trùng key của mongoose, nếu không phải thì trả null
const handleMongooseError = (res, error) => {
  if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern)[0];
    return res.status(409).json({
      success: false,
      message: `Giá trị của "${field}" đã tồn tại`,
    });
  }
  return null;
};

const roleController = {
  // Tạo vai trò mới
  createRole: async (req, res) => {
    try {
      const { name, code, description, permissions, isActive } = req.body;

      const role = await Role.create({
        name,
        code,
        description,
        permissions,
        isActive,
        // isSystem không cho client tự set, chỉ tạo qua seed/script
      });

      return res.status(201).json({
        success: true,
        message: 'Tạo vai trò thành công',
        data: role,
      });
    } catch (error) {
      return handleMongooseError(res, error) || serverError(res, error);
    }
  },

  // Lấy tất cả vai trò (có phân trang, tìm kiếm, lọc), kèm số tài khoản và danh sách tài khoản
  // Riêng vai trò mặc định (USER) chỉ trả số tài khoản, không trả danh sách
  getAllRoles: async (req, res) => {
    try {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
      const { search, isActive } = req.query;

      const filter = {};

      if (search) {
        // Escape ký tự đặc biệt của regex để tránh lỗi/ReDoS
        const keyword = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { name: { $regex: keyword, $options: 'i' } },
          { code: { $regex: keyword, $options: 'i' } },
        ];
      }

      if (isActive !== undefined) {
        filter.isActive = isActive === 'true';
      }

      const [roles, total] = await Promise.all([
        Role.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Role.countDocuments(filter),
      ]);

      // Tách vai trò mặc định: chỉ đếm; các vai trò còn lại: đếm + lấy danh sách
      // (aggregate không tự ép kiểu, roles._id đã là ObjectId nhờ lean())
      const defaultIds = roles.filter((r) => r.code === DEFAULT_ROLE_CODE).map((r) => r._id);
      const listIds = roles.filter((r) => r.code !== DEFAULT_ROLE_CODE).map((r) => r._id);

      const [listStats, defaultCounts] = await Promise.all([
        listIds.length
          ? Users.aggregate([
              { $match: { role: { $in: listIds } } },
              { $sort: { createdAt: -1 } },
              {
                $group: {
                  _id: '$role',
                  count: { $sum: 1 },
                  users: {
                    $push: { _id: '$_id', name: '$name', email: '$email', avatar: '$avatar' },
                  },
                },
              },
              { $project: { count: 1, users: { $slice: ['$users', MAX_USERS_PER_ROLE] } } },
            ])
          : [],
        defaultIds.length
          ? Users.aggregate([
              { $match: { role: { $in: defaultIds } } },
              { $group: { _id: '$role', count: { $sum: 1 } } },
            ])
          : [],
      ]);

      const statMap = new Map([...listStats, ...defaultCounts].map((s) => [String(s._id), s]));

      const data = roles.map((r) => {
        const s = statMap.get(String(r._id));
        return { ...r, userCount: s?.count || 0, users: s?.users || [] };
      });

      return res.status(200).json({
        success: true,
        data,
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      return serverError(res, error);
    }
  },

  // Lấy vai trò theo ID
  getRoleById: async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      }

      const role = await Role.findById(id);

      if (!role) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy vai trò' });
      }

      return res.status(200).json({ success: true, data: role });
    } catch (error) {
      return serverError(res, error);
    }
  },

  // Cập nhật vai trò
  updateRole: async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      }

      const role = await Role.findById(id);

      if (!role) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy vai trò' });
      }

      // Chỉ lấy các field được phép cập nhật
      const updates = {};
      UPDATABLE_FIELDS.forEach((field) => {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      });

      // Vai trò hệ thống: không cho vô hiệu hóa
      if (role.isSystem && updates.isActive === false) {
        return res.status(403).json({
          success: false,
          message: 'Không thể vô hiệu hóa vai trò hệ thống',
        });
      }

      role.set(updates);
      await role.save(); // save() để chạy đầy đủ validator

      return res.status(200).json({
        success: true,
        message: 'Cập nhật vai trò thành công',
        data: role,
      });
    } catch (error) {
      return handleMongooseError(res, error) || serverError(res, error);
    }
  },

  // Xóa vai trò
  deleteRole: async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidId(id)) {
        return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      }

      const role = await Role.findById(id);

      if (!role) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy vai trò' });
      }

      if (role.isSystem) {
        return res.status(403).json({
          success: false,
          message: 'Không thể xóa vai trò hệ thống',
        });
      }

      // Còn tài khoản đang dùng vai trò này thì không cho xóa
      const inUse = await Users.exists({ role: id });
      if (inUse) {
        return res.status(409).json({
          success: false,
          message: 'Vai trò đang có tài khoản, hãy gỡ hết tài khoản trước khi xóa',
        });
      }

      await role.deleteOne();

      return res.status(200).json({
        success: true,
        message: 'Xóa vai trò thành công',
      });
    } catch (error) {
      return serverError(res, error);
    }
  },

  // Gỡ tài khoản khỏi vai trò -> về vai trò mặc định USER
  removeUserFromRole: async (req, res) => {
    try {
      const { id, userId } = req.params;

      if (!isValidId(id) || !isValidId(userId)) {
        return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      }

      if (req.user._id.toString() === userId) {
        return res.status(403).json({
          success: false,
          message: 'Bạn không thể tự gỡ vai trò của chính mình',
        });
      }

      const role = await Role.findById(id);
      if (!role) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy vai trò' });
      }

      if (role.code === DEFAULT_ROLE_CODE) {
        return res.status(400).json({
          success: false,
          message: 'Đây là vai trò mặc định, không thể gỡ',
        });
      }

      const defaultRole = await Role.findOne({ code: DEFAULT_ROLE_CODE });
      if (!defaultRole || !defaultRole.isActive) {
        return res.status(409).json({
          success: false,
          message: 'Vai trò mặc định (USER) không tồn tại hoặc đang bị vô hiệu hóa',
        });
      }

      // Không cho gỡ quản trị viên cuối cùng
      if (role.code === ADMIN_ROLE_CODE) {
        const adminCount = await Users.countDocuments({ role: role._id });
        if (adminCount <= 1) {
          return res.status(409).json({
            success: false,
            message: 'Không thể gỡ quản trị viên cuối cùng',
          });
        }
      }

      // Điều kiện role: role._id đảm bảo tài khoản đang thật sự thuộc vai trò này
      const user = await Users.findOneAndUpdate(
        { _id: userId, role: role._id },
        { role: defaultRole._id },
        { returnDocument: 'after' }
      )
        .select('-password')
        .populate('role', 'name code');

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Tài khoản không tồn tại hoặc không thuộc vai trò này',
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Đã gỡ vai trò, tài khoản chuyển về vai trò mặc định',
        data: user,
      });
    } catch (error) {
      return serverError(res, error);
    }
  },
};

export default roleController;