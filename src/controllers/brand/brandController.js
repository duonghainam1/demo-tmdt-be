import Brands from "../../models/products/brandModel.js";
import { generateUniqueSlug } from "../../utils/slugify.js";
import {
    uploadImageToCloudinary,
    deleteImageFromCloudinary,
} from "../../utils/uploadCloudinary.js";

// Số bản ghi tối đa mỗi trang (chặn client xin limit quá lớn)
const MAX_LIMIT = 100;

// Escape ký tự đặc biệt của regex để từ khóa tìm kiếm luôn được hiểu là chữ thường
// (tránh lỗi 500 khi gõ "(", "[", "*"... và tránh ReDoS)
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const brandController = {
    createBrand: async (req, res) => {
        let uploaded = null; // để rollback nếu lỗi xảy ra sau khi upload

        try {
            const { name, description, website } = req.body;

            // Kiểm tra tên thương hiệu
            if (!name || !name.trim()) {
                return res.status(400).json({
                    message: "Tên thương hiệu không được để trống",
                });
            }

            // Kiểm tra thương hiệu đã tồn tại theo tên
            const existingBrand = await Brands.findOne({ name: name.trim() });
            if (existingBrand) {
                return res.status(400).json({
                    message: "Thương hiệu đã tồn tại",
                });
            }

            // Upload ảnh (nếu có) trước
            if (req.file) {
                uploaded = await uploadImageToCloudinary(req.file.buffer, "brands");
            }

            // Tạo slug duy nhất bằng util dùng chung
            const slug = await generateUniqueSlug(name.trim(), Brands);

            // Tạo thương hiệu
            const brand = await Brands.create({
                name: name.trim(),
                slug,
                logo: uploaded
                    ? { url: uploaded.secure_url, publicId: uploaded.public_id }
                    : undefined,
                description: description || "",
                website: website || "",
            });

            return res.status(201).json({
                message: "Tạo thương hiệu thành công",
                data: brand,
            });
        } catch (error) {
            console.error("Create brand error:", error);

            // Nếu đã upload ảnh nhưng tạo brand thất bại -> xóa ảnh đã đẩy lên
            if (uploaded?.public_id) {
                try {
                    await deleteImageFromCloudinary(uploaded.public_id);
                } catch (cleanupErr) {
                    console.error("Cleanup uploaded image error:", cleanupErr);
                }
            }

            if (error.code === 11000) {
                return res.status(400).json({
                    message: "Slug thương hiệu đã tồn tại",
                });
            }

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },

    // Danh sách thương hiệu: phân trang + tìm kiếm trên TOÀN BỘ dữ liệu.
    // Bộ lọc (search/status) được áp dụng TRƯỚC khi skip/limit, nên đang ở trang nào
    // cũng tìm được thương hiệu nằm ở trang khác; total/totalPages tính theo kết quả đã lọc.
    getAllBrands: async (req, res) => {
        try {
            const { page = 1, limit = 10 } = req.query;

            // Chỉ nhận chuỗi: ?search[]=a hoặc ?search[$ne]=a sẽ bị bỏ qua thay vì làm hỏng truy vấn
            const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
            const status = typeof req.query.status === "string" ? req.query.status : "";

            const filter = {};

            if (status === "active") {
                filter.isActive = true;
            } else if (status === "inactive") {
                filter.isActive = false;
            }

            if (search) {
                const regex = new RegExp(escapeRegex(search), "i");
                filter.$or = [{ name: regex }, { slug: regex }];
            }

            const pageNum = Math.max(1, parseInt(page, 10) || 1);
            const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 10));
            const skip = (pageNum - 1) * limitNum;

            const [brands, total] = await Promise.all([
                // _id làm tiêu chí phụ để thứ tự giữa các trang luôn ổn định
                // (tránh trùng/sót bản ghi khi nhiều brand có cùng createdAt)
                Brands.find(filter)
                    .sort({ createdAt: -1, _id: -1 })
                    .skip(skip)
                    .limit(limitNum),
                Brands.countDocuments(filter),
            ]);

            return res.status(200).json({
                message: "Lấy danh sách thương hiệu thành công",
                data: brands,
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / limitNum)),
                },
            });
        } catch (error) {
            console.error("Get all brands error:", error);
            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },

    updateBrand: async (req, res) => {
        let uploaded = null; // ảnh mới upload trong request này, để rollback nếu lỗi

        try {
            const { id } = req.params;
            const { name, description, website, isActive } = req.body;

            const brand = await Brands.findById(id);
            if (!brand) {
                return res.status(404).json({
                    message: "Không tìm thấy thương hiệu",
                });
            }

            if (name !== undefined) {
                if (!name.trim()) {
                    return res.status(400).json({
                        message: "Tên thương hiệu không được để trống",
                    });
                }
                const existingBrand = await Brands.findOne({
                    _id: { $ne: id },
                    name: name.trim(),
                });
                if (existingBrand) {
                    return res.status(400).json({
                        message: "Thương hiệu đã tồn tại",
                    });
                }
                if (name.trim() !== brand.name) {
                    brand.slug = await generateUniqueSlug(name.trim(), Brands);
                }
                brand.name = name.trim();
            }

            // Upload ảnh mới (nếu có) trước khi ghi vào brand
            let previousPublicId = null;
            if (req.file) {
                uploaded = await uploadImageToCloudinary(req.file.buffer, "brands");
                previousPublicId = brand.logo?.publicId || null;
                brand.logo = {
                    url: uploaded.secure_url,
                    publicId: uploaded.public_id,
                };
            }

            if (description !== undefined) brand.description = description;
            if (website !== undefined) brand.website = website;
            if (isActive !== undefined) brand.isActive = isActive;

            await brand.save();

            // Lưu thành công -> xóa ảnh cũ trên Cloudinary (nếu vừa thay ảnh mới)
            if (previousPublicId) {
                try {
                    await deleteImageFromCloudinary(previousPublicId);
                } catch (cleanupErr) {
                    console.error("Delete old logo error:", cleanupErr);
                }
            }

            return res.status(200).json({
                message: "Cập nhật thương hiệu thành công",
                data: brand,
            });
        } catch (error) {
            console.error("Update brand error:", error);

            // Nếu đã upload ảnh mới nhưng save thất bại -> xóa ảnh vừa upload
            if (uploaded?.public_id) {
                try {
                    await deleteImageFromCloudinary(uploaded.public_id);
                } catch (cleanupErr) {
                    console.error("Cleanup uploaded image error:", cleanupErr);
                }
            }

            if (error.name === "CastError") {
                return res.status(400).json({
                    message: "ID thương hiệu không hợp lệ",
                });
            }

            if (error.code === 11000) {
                return res.status(400).json({
                    message: "Slug thương hiệu đã tồn tại",
                });
            }

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },

    deleteBrand: async (req, res) => {
        try {
            const { id } = req.params;

            const brand = await Brands.findById(id);
            if (!brand) {
                return res.status(404).json({
                    message: "Không tìm thấy thương hiệu",
                });
            }

            const publicId = brand.logo?.publicId;

            await Brands.findByIdAndDelete(id);

            // Xóa document thành công -> xóa ảnh trên Cloudinary (nếu có)
            if (publicId) {
                try {
                    await deleteImageFromCloudinary(publicId);
                } catch (cleanupErr) {
                    console.error("Delete brand logo error:", cleanupErr);
                    // Không fail request vì brand đã xóa thành công, chỉ log lại để xử lý thủ công
                }
            }

            return res.status(200).json({
                message: "Xóa thương hiệu thành công",
            });
        } catch (error) {
            console.error("Delete brand error:", error);

            if (error.name === "CastError") {
                return res.status(400).json({
                    message: "ID thương hiệu không hợp lệ",
                });
            }

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },
};

export default brandController;