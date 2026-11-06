import mongoose from "mongoose";
import Attributes, {
    ATTRIBUTE_TYPES,
    ATTRIBUTE_INPUT_TYPES,
} from "../../models/products/attributeModel.js";
import Products from "../../models/products/productModel.js";
import ProductVariants from "../../models/products/productVariantModel.js";
import { generateUniqueSlug, toSlug } from "../../utils/slugify.js";

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Chuẩn hóa + kiểm tra bộ (type, inputType).
 * - variant luôn là select
 * Trả về { type, inputType } hoặc { error }
 */
const resolveTypeConfig = (type, inputType) => {
    if (!ATTRIBUTE_TYPES.includes(type)) {
        return { error: "Loại thuộc tính không hợp lệ (variant | spec)" };
    }
    const input = inputType ?? "select";
    if (!ATTRIBUTE_INPUT_TYPES.includes(input)) {
        return { error: "inputType không hợp lệ (select | text)" };
    }
    if (type === "variant" && input !== "select") {
        return { error: "Thuộc tính biến thể chỉ được chọn từ danh sách giá trị" };
    }
    return { type, inputType: input };
};

/**
 * Đếm mức độ sử dụng của attribute:
 * - Sản phẩm dùng làm thuộc tính biến thể (variantAttributes) hoặc thông số (specs)
 *   (KHÔNG lọc deletedAt: sản phẩm trong thùng rác có thể được khôi phục)
 * - Biến thể (SKU) đang dùng
 */
const getAttributeUsage = async (attributeId) => {
    const productFilter = {
        $or: [{ variantAttributes: attributeId }, { "specs.attribute": attributeId }],
    };
    const [productCount, variantCount, sampleProducts] = await Promise.all([
        Products.countDocuments(productFilter),
        ProductVariants.countDocuments({ "attributes.attribute": attributeId }),
        Products.find(productFilter).select("name deletedAt").limit(5).lean(),
    ]);
    return {
        used: productCount > 0 || variantCount > 0,
        productCount,
        variantCount,
        sampleProducts: sampleProducts.map((p) => ({
            _id: p._id,
            name: p.name,
            inTrash: !!p.deletedAt,
        })),
    };
};

/**
 * Gộp danh sách values client gửi lên với values hiện có.
 * - Match theo _id (nếu client gửi), không có thì match theo slug.
 * - Value khớp    -> giữ nguyên _id (variant/spec không bị mồ côi valueId)
 * - Value mới     -> _id mới
 * - Value vắng mặt -> coi là bị xóa (trả về trong `removed`)
 * - Value đổi tên -> trả về trong `renamed` để đồng bộ snapshot ở variant / specs
 */
const mergeValues = (existingValues, incoming) => {
    const existingById = new Map(existingValues.map((v) => [String(v._id), v]));
    const existingBySlug = new Map(existingValues.map((v) => [v.slug, v]));

    const matchedIds = new Set();
    const slugs = new Set();
    const merged = [];
    const renamed = [];

    for (const item of incoming) {
        const text = item?.value?.trim();
        if (!text) continue;

        const slug = toSlug(text);
        if (slugs.has(slug)) {
            return { error: "Các giá trị thuộc tính không được trùng nhau" };
        }
        slugs.add(slug);

        let old = null;
        if (item._id && isValidId(item._id)) {
            old = existingById.get(String(item._id)) || null;
        }
        if (!old) old = existingBySlug.get(slug) || null;

        if (old && matchedIds.has(String(old._id))) {
            return { error: "Các giá trị thuộc tính không được trùng nhau" };
        }

        if (old) {
            matchedIds.add(String(old._id));
            if (old.value !== text) renamed.push({ valueId: old._id, value: text, slug });
            merged.push({
                _id: old._id,
                value: text,
                slug,
                meta: item.meta ?? old.meta ?? "",
            });
        } else {
            merged.push({ value: text, slug, meta: item.meta || "" });
        }
    }

    const removed = existingValues.filter((v) => !matchedIds.has(String(v._id)));
    return { merged, removed, renamed };
};

const attributeController = {
    // ==========================================
    // CREATE ATTRIBUTE
    // ==========================================
    createAttribute: async (req, res) => {
        try {
            const {
                name,
                values = [],
                isActive = true,
                type = "variant",
                inputType,
                isFilterable = true,
            } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({
                    message: "Tên thuộc tính không được để trống",
                });
            }

            const attributeName = name.trim();

            if (!Array.isArray(values)) {
                return res.status(400).json({
                    message: "values phải là một mảng",
                });
            }

            const cfg = resolveTypeConfig(type, inputType);
            if (cfg.error) return res.status(400).json({ message: cfg.error });

            // Kiểu nhập tay không có danh sách giá trị
            const attributeValues =
                cfg.inputType === "text"
                    ? []
                    : values
                          .filter((item) => item?.value?.trim())
                          .map((item) => ({
                              value: item.value.trim(),
                              slug: toSlug(item.value),
                              meta: item.meta || "",
                          }));

            const valueSlugs = attributeValues.map((item) => item.slug);
            if (new Set(valueSlugs).size !== valueSlugs.length) {
                return res.status(400).json({
                    message: "Các giá trị thuộc tính không được trùng nhau",
                });
            }

            // Sinh slug duy nhất (tự thêm hậu tố -1, -2... nếu trùng)
            const slug = await generateUniqueSlug(attributeName, Attributes);

            const attribute = await Attributes.create({
                name: attributeName,
                slug,
                type: cfg.type,
                inputType: cfg.inputType,
                isFilterable: isFilterable !== false && isFilterable !== "false",
                values: attributeValues,
                isActive,
            });

            return res.status(201).json({
                message: "Tạo thuộc tính thành công",
                data: attribute,
            });
        } catch (error) {
            console.error("Create attribute error:", error);

            if (error.code === 11000) {
                return res.status(400).json({
                    message: "Thuộc tính hoặc slug đã tồn tại",
                });
            }

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },

    // ==========================================
    // GET ATTRIBUTES (phân trang + tìm kiếm + lọc trạng thái + lọc loại)
    // ?type=variant|spec  (variant bao gồm cả dữ liệu cũ chưa có type)
    // ==========================================
    getAttributes: async (req, res) => {
        try {
            const { isActive, search, type, page = 1, limit = 10 } = req.query;

            const filter = {};

            if (isActive !== undefined) {
                filter.isActive = isActive === "true";
            }

            if (type !== undefined && type !== "" && type !== "all") {
                if (!ATTRIBUTE_TYPES.includes(type)) {
                    return res.status(400).json({ message: "type không hợp lệ" });
                }
                filter.type = type === "spec" ? "spec" : { $ne: "spec" };
            }

            if (search && search.trim()) {
                const keyword = search.trim();
                filter.$or = [
                    { name: { $regex: keyword, $options: "i" } },
                    { slug: { $regex: toSlug(keyword), $options: "i" } },
                ];
            }

            const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
            const limitNumber = Math.max(parseInt(limit, 10) || 10, 1);
            const skip = (pageNumber - 1) * limitNumber;

            const [attributes, total] = await Promise.all([
                Attributes.find(filter)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNumber),
                Attributes.countDocuments(filter),
            ]);

            return res.status(200).json({
                message: "Lấy danh sách thuộc tính thành công",
                data: attributes,
                pagination: {
                    page: pageNumber,
                    limit: limitNumber,
                    total,
                    totalPages: Math.max(Math.ceil(total / limitNumber), 1),
                },
            });
        } catch (error) {
            console.error("Get attributes error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    },

    // ==========================================
    // UPDATE ATTRIBUTE
    // - Giữ nguyên _id của value cũ (không làm mồ côi valueId ở variant / specs)
    // - Chặn xóa value đang được biến thể hoặc thông số sử dụng (409)
    // - Chặn đổi type / inputType khi attribute đang được dùng (409)
    // - Đổi tên attribute / value -> đồng bộ snapshot trong ProductVariants và Products.specs
    // ==========================================
    updateAttribute: async (req, res) => {
        try {
            const { id } = req.params;
            const { name, values, isActive, type, inputType, isFilterable } = req.body;

            if (!isValidId(id)) {
                return res.status(400).json({ message: "ID thuộc tính không hợp lệ" });
            }

            const attribute = await Attributes.findById(id);
            if (!attribute) {
                return res.status(404).json({ message: "Không tìm thấy thuộc tính" });
            }

            let nameChanged = false;
            let renamedValues = [];

            // ----- Loại / kiểu nhập -----
            const currentType = attribute.type || "variant";
            const currentInput = attribute.inputType || "select";
            const cfg = resolveTypeConfig(
                type !== undefined ? type : currentType,
                inputType !== undefined ? inputType : currentInput
            );
            if (cfg.error) return res.status(400).json({ message: cfg.error });

            if (cfg.type !== currentType || cfg.inputType !== currentInput) {
                const usage = await getAttributeUsage(attribute._id);
                if (usage.used) {
                    return res.status(409).json({
                        message: `Thuộc tính "${attribute.name}" đang được sử dụng, không thể đổi loại / kiểu nhập`,
                        data: usage,
                    });
                }
                attribute.type = cfg.type;
                attribute.inputType = cfg.inputType;
                if (cfg.inputType === "text") attribute.values = [];
            }

            // ----- Tên -----
            if (name !== undefined) {
                if (typeof name !== "string" || !name.trim()) {
                    return res.status(400).json({
                        message: "Tên thuộc tính không được để trống",
                    });
                }

                const attributeName = name.trim();

                if (attributeName !== attribute.name) {
                    attribute.slug = await generateUniqueSlug(attributeName, Attributes, {
                        excludeId: attribute._id,
                    });
                    attribute.name = attributeName;
                    nameChanged = true;
                }
            }

            // ----- Values (bỏ qua với kiểu nhập tay) -----
            if (values !== undefined && cfg.inputType !== "text") {
                if (!Array.isArray(values)) {
                    return res.status(400).json({ message: "values phải là một mảng" });
                }

                const result = mergeValues(attribute.values, values);
                if (result.error) {
                    return res.status(400).json({ message: result.error });
                }

                // Chặn xóa value đang được biến thể / thông số sản phẩm sử dụng
                if (result.removed.length > 0) {
                    const removedIds = result.removed.map((v) => v._id);

                    const [variantUsage, specUsage] = await Promise.all([
                        ProductVariants.aggregate([
                            { $match: { "attributes.attribute": attribute._id } },
                            { $unwind: "$attributes" },
                            {
                                $match: {
                                    "attributes.attribute": attribute._id,
                                    "attributes.valueId": { $in: removedIds },
                                },
                            },
                            { $group: { _id: "$attributes.valueId", variantCount: { $sum: 1 } } },
                        ]),
                        Products.aggregate([
                            { $match: { "specs.valueId": { $in: removedIds } } },
                            { $unwind: "$specs" },
                            {
                                $match: {
                                    "specs.attribute": attribute._id,
                                    "specs.valueId": { $in: removedIds },
                                },
                            },
                            { $group: { _id: "$specs.valueId", productCount: { $sum: 1 } } },
                        ]),
                    ]);

                    if (variantUsage.length > 0 || specUsage.length > 0) {
                        const nameById = new Map(
                            result.removed.map((v) => [String(v._id), v.value])
                        );
                        const usedMap = new Map();
                        variantUsage.forEach((u) =>
                            usedMap.set(String(u._id), {
                                valueId: u._id,
                                value: nameById.get(String(u._id)),
                                variantCount: u.variantCount,
                                productCount: 0,
                            })
                        );
                        specUsage.forEach((u) => {
                            const key = String(u._id);
                            const cur = usedMap.get(key) || {
                                valueId: u._id,
                                value: nameById.get(key),
                                variantCount: 0,
                                productCount: 0,
                            };
                            cur.productCount = u.productCount;
                            usedMap.set(key, cur);
                        });

                        return res.status(409).json({
                            message:
                                "Không thể xóa giá trị đang được biến thể / thông số sản phẩm sử dụng. Hãy gỡ/đổi chúng trước",
                            data: { usedValues: [...usedMap.values()] },
                        });
                    }
                }

                attribute.values = result.merged;
                renamedValues = result.renamed;
            }

            if (isFilterable !== undefined) {
                attribute.isFilterable = isFilterable === true || isFilterable === "true";
            }

            if (isActive !== undefined) {
                attribute.isActive = isActive;
            }

            await attribute.save();

            // ----- Đồng bộ snapshot (sau khi lưu thành công) -----
            try {
                if (nameChanged) {
                    await ProductVariants.updateMany(
                        { "attributes.attribute": attribute._id },
                        { $set: { "attributes.$[a].attributeName": attribute.name } },
                        { arrayFilters: [{ "a.attribute": attribute._id }] }
                    );
                    await Products.updateMany(
                        { "specs.attribute": attribute._id },
                        { $set: { "specs.$[s].attributeName": attribute.name } },
                        { arrayFilters: [{ "s.attribute": attribute._id }] }
                    );
                }
                for (const r of renamedValues) {
                    await ProductVariants.updateMany(
                        {
                            attributes: {
                                $elemMatch: { attribute: attribute._id, valueId: r.valueId },
                            },
                        },
                        { $set: { "attributes.$[a].value": r.value } },
                        {
                            arrayFilters: [
                                { "a.attribute": attribute._id, "a.valueId": r.valueId },
                            ],
                        }
                    );
                    await Products.updateMany(
                        {
                            specs: {
                                $elemMatch: { attribute: attribute._id, valueId: r.valueId },
                            },
                        },
                        {
                            $set: {
                                "specs.$[s].value": r.value,
                                "specs.$[s].valueSlug": r.slug,
                            },
                        },
                        {
                            arrayFilters: [
                                { "s.attribute": attribute._id, "s.valueId": r.valueId },
                            ],
                        }
                    );
                }
            } catch (syncErr) {
                // Không làm hỏng việc cập nhật; snapshot cũ vẫn hiển thị được
                console.error("Update attribute: đồng bộ snapshot thất bại:", syncErr);
            }

            return res.status(200).json({
                message: "Cập nhật thuộc tính thành công",
                data: attribute,
            });
        } catch (error) {
            console.error("Update attribute error:", error);

            if (error.code === 11000) {
                return res.status(400).json({
                    message: "Thuộc tính hoặc slug đã tồn tại",
                });
            }
            if (error.name === "CastError") {
                return res.status(400).json({ message: "ID thuộc tính không hợp lệ" });
            }
            return res.status(500).json({ message: "Internal server error" });
        }
    },

    // ==========================================
    // DELETE ATTRIBUTE
    // Chặn xóa nếu còn Product (kể cả đã soft-delete) hoặc ProductVariant dùng
    // (dùng làm thuộc tính biến thể HOẶC thông số)
    // ==========================================
    deleteAttribute: async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({ message: "ID thuộc tính không hợp lệ" });
            }

            const attribute = await Attributes.findById(id).select("_id name");
            if (!attribute) {
                return res.status(404).json({ message: "Không tìm thấy thuộc tính" });
            }

            const usage = await getAttributeUsage(attribute._id);

            if (usage.used) {
                return res.status(409).json({
                    message: `Thuộc tính "${attribute.name}" đang được sử dụng, không thể xóa. Bạn có thể chuyển sang Ngưng hoạt động`,
                    data: {
                        productCount: usage.productCount,
                        variantCount: usage.variantCount,
                        sampleProducts: usage.sampleProducts,
                    },
                });
            }

            await Attributes.deleteOne({ _id: attribute._id });

            return res.status(200).json({
                message: "Xóa thuộc tính thành công",
            });
        } catch (error) {
            console.error("Delete attribute error:", error);

            if (error.name === "CastError") {
                return res.status(400).json({ message: "ID thuộc tính không hợp lệ" });
            }
            return res.status(500).json({ message: "Internal server error" });
        }
    },
};

export default attributeController;