import Categorys from '../../models/categories/categoryModel.js';
import { generateUniqueSlug } from '../../utils/slugify.js';
import { deleteImageFromCloudinary, uploadImageToCloudinary } from '../../utils/uploadCloudinary.js';
import Products from '../../models/products/productModel.js';
const buildCategoryTree = (list) => {
  const map = new Map();
  list.forEach((c) => map.set(String(c._id), { ...c, children: [] }));
 
  const roots = [];
  map.forEach((node) => {
    const parentId = node.parent?._id ? String(node.parent._id) : node.parent ? String(node.parent) : null;
 
    if (!parentId) {
      roots.push(node);
      return;
    }
    // Nếu cha không có trong danh sách (vd: cha đang bị ẩn) thì bỏ qua con
    map.get(parentId)?.children.push(node);
  });
 
  return roots;
};
const categoryController = {
  // ========== THÊM DANH MỤC ==========
createCategory: async (req, res) => {
  let uploadedImage = null;

  try {
    const {
      name,
      description,
      parent,
      sortOrder,
      isActive,
    } = req.body;

    // =========================
    // VALIDATE
    // =========================

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Thiếu trường 'name'",
      });
    }
if (!req.file) {
  return res.status(400).json({ success: false, message: "Thiếu ảnh danh mục" });
}
    // =========================
    // UPLOAD IMAGE
    // =========================

    let image = {
      url: '',
      publicId: '',
    };

    if (req.file) {
      uploadedImage = await uploadImageToCloudinary(
        req.file.buffer,
        'categories'
      );

      image = {
        url: uploadedImage.secure_url,
        publicId: uploadedImage.public_id,
      };
    }

    // =========================
    // GENERATE SLUG
    // =========================

    const slug = await generateUniqueSlug(
      name,
      Categorys
    );

    // =========================
    // CREATE CATEGORY
    // =========================

    const newCategory = new Categorys({
      name: name.trim(),
      slug,
      description,
      parent: parent || null,
      image,
      sortOrder: sortOrder ?? 0,
      isActive: isActive ?? true,
    });

    await newCategory.save();

    return res.status(201).json({
      success: true,
      message: 'Tạo danh mục thành công',
      category: newCategory,
    });

  } catch (error) {
    console.error('createCategory error:', error);

    // =========================
    // ROLLBACK CLOUDINARY
    // =========================

    if (uploadedImage?.public_id) {
      try {
        await deleteImageFromCloudinary(
          uploadedImage.public_id
        );

        console.log(
          'Đã rollback ảnh Cloudinary:',
          uploadedImage.public_id
        );
      } catch (deleteError) {
        console.error(
          'Không thể xóa ảnh Cloudinary khi rollback:',
          deleteError
        );
      }
    }

    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi tạo danh mục',
      error: error.message,
    });
  }
},


getCategories: async (req, res) => {
  try {
    const {
      parent,
      isActive,
      search,
      tree, // tree=true -> trả về dạng cây, KHÔNG phân trang
      page = 1,
      limit = 10,
      sortBy = 'sortOrder',
      sortOrder = 'asc',
    } = req.query;
 
    const allowedSortFields = ['sortOrder', 'createdAt', 'name'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'sortOrder';
    const sortDirection = sortOrder === 'desc' ? -1 : 1;
    const sort = { [sortField]: sortDirection, createdAt: -1 };
 
    // Thống kê chung (chạy song song, mỗi loại 1 query duy nhất)
    const [totalAll, activeCount, rootCount] = await Promise.all([
      Categorys.countDocuments({}),
      Categorys.countDocuments({ isActive: true }),
      Categorys.countDocuments({ parent: null }),
    ]);
 
    const stats = {
      total: totalAll,
      active: activeCount,
      inactive: totalAll - activeCount,
      root: rootCount,
    };
 
    // =========================
    // CHẾ ĐỘ CÂY (dùng cho menu)
    // =========================
    if (tree === 'true') {
      const treeFilter = {};
      if (isActive !== undefined) {
        treeFilter.isActive = isActive === 'true';
      }
 
      const all = await Categorys.find(treeFilter)
        .populate('parent', 'name slug')
        .sort({ sortOrder: 1, name: 1 })
        .lean();
 
      return res.status(200).json({
        message: 'Get categories successfully',
        categories: buildCategoryTree(all), // chỉ gồm danh mục gốc, con nằm trong children
        stats,
      });
    }
 
    // =========================
    // CHẾ ĐỘ DANH SÁCH PHẲNG (dùng cho trang quản trị, có phân trang)
    // =========================
    const filter = {};
 
    if (parent !== undefined) {
      filter.parent = parent === 'null' ? null : parent;
    }
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }
    if (search) {
      // escape ký tự đặc biệt để tránh lỗi regex
      const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      filter.$or = [{ name: regex }, { slug: regex }];
    }
 
    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const limitNumber = Math.max(parseInt(limit, 10) || 10, 1);
    const skip = (pageNumber - 1) * limitNumber;
 
    const [categories, total] = await Promise.all([
      Categorys.find(filter)
        .populate('parent', 'name slug')
        .sort(sort)
        .skip(skip)
        .limit(limitNumber),
      Categorys.countDocuments(filter),
    ]);
 
    return res.status(200).json({
      message: 'Get categories successfully',
      categories,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        totalPages: Math.ceil(total / limitNumber),
      },
      stats,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: 'Internal server error' });
  }
},
updateCategory: async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      parent,
      sortOrder,
      isActive,
    } = req.body;
if (!req.file && !category.image?.url) {
  return res.status(400).json({ success: false, message: "Thiếu ảnh danh mục" });
}
    const category = await Categorys.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy danh mục',
      });
    }

    // Không cho category làm con của chính nó
    if (parent && parent === id) {
      return res.status(400).json({
        success: false,
        message: 'Danh mục không thể là con của chính nó',
      });
    }

    // =========================
    // UPDATE NAME / SLUG
    // =========================

    if (name && name !== category.name) {
      category.slug = await generateUniqueSlug(
        name,
        Categorys,
        {
          excludeId: id,
        }
      );

      category.name = name;
    }

    // =========================
    // UPDATE IMAGE
    // =========================

    if (req.file) {
      // Upload ảnh mới
      const uploaded = await uploadImageToCloudinary(
        req.file.buffer,
        'categories'
      );

      // Lưu publicId cũ trước khi thay đổi
      const oldPublicId = category.image?.publicId;

      // Cập nhật ảnh mới
      category.image = {
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
      };

      await category.save();

      // Sau khi DB lưu thành công mới xóa ảnh cũ
      if (oldPublicId) {
        try {
          await deleteImageFromCloudinary(oldPublicId);
        } catch (cloudinaryError) {
          console.error(
            'Không thể xóa ảnh cũ trên Cloudinary:',
            cloudinaryError
          );
        }
      }
    }

    // =========================
    // UPDATE OTHER FIELDS
    // =========================

    if (description !== undefined) {
      category.description = description;
    }

    if (parent !== undefined) {
      category.parent = parent || null;
    }

    if (sortOrder !== undefined) {
      category.sortOrder = sortOrder;
    }

    if (isActive !== undefined) {
      category.isActive = isActive;
    }

    await category.save();

    return res.status(200).json({
      success: true,
      message: 'Cập nhật danh mục thành công',
      category,
    });

  } catch (error) {
    console.error('updateCategory error:', error);

    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi cập nhật danh mục',
      error: error.message,
    });
  }
},
deleteCategory: async (req, res) => {
  try {
    const { id } = req.params;

    // =========================
    // VALIDATE ID
    // =========================

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu id danh mục',
      });
    }

    // =========================
    // FIND CATEGORY
    // =========================

    const category = await Categorys.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy danh mục',
      });
    }

    // =========================
    // CHECK CHILDREN
    // =========================

    const hasChildren = await Categorys.exists({
      parent: category._id,
    });

    if (hasChildren) {
      return res.status(400).json({
        success: false,
        code: 'CATEGORY_HAS_CHILDREN',
        message:
          'Không thể xóa danh mục đang có danh mục con. Vui lòng xử lý các danh mục con trước.',
      });
    }

    // =========================
    // CHECK PRODUCTS
    // =========================

    const hasProducts = await Products.exists({
      category: category._id,
    });

    if (hasProducts) {
      return res.status(400).json({
        success: false,
        code: 'CATEGORY_HAS_PRODUCTS',
        message:
          'Không thể xóa danh mục đang có sản phẩm. Vui lòng chuyển sản phẩm sang danh mục khác trước.',
      });
    }

    // =========================
    // SAVE IMAGE PUBLIC ID
    // =========================

    const imagePublicId = category.image?.publicId;

    // =========================
    // DELETE CATEGORY
    // =========================

    await Categorys.findByIdAndDelete(id);

    // =========================
    // DELETE CLOUDINARY IMAGE
    // =========================

    if (imagePublicId) {
      try {
        await deleteImageFromCloudinary(imagePublicId);
      } catch (cloudinaryError) {
        // Không làm request thất bại vì Category
        // đã được xóa thành công
        console.error(
          'Không thể xóa ảnh trên Cloudinary:',
          cloudinaryError
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Xóa danh mục thành công',
      data: {
        id: category._id,
        name: category.name,
      },
    });

  } catch (error) {
    console.error('deleteCategory error:', error);

    return res.status(500).json({
      success: false,
      message: 'Lỗi server khi xóa danh mục',
      error: error.message,
    });
  }
},
};

export default categoryController;