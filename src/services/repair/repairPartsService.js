import mongoose from "mongoose";
// Chỉnh lại đường dẫn cho đúng project
import Products from "../../models/products/productModel.js";
import ProductVariants from "../../models/products/productVariantModel.js";
import Inventory from "../../models/inventory/inventoryModel.js";
import InventoryTransactions from "../../models/inventory/inventoryTransactionModel.js";

/* =====================================================================================
 *  LINH KIỆN & TIỀN CÔNG CHO ĐƠN SỬA CHỮA
 *  - Lưu đơn: chỉ KIỂM TRA tồn kho, chưa trừ (lưu nhiều lần không bị trừ lặp).
 *  - Chuyển sang "completed": xuất kho thật (giảm Inventory.quantity + ghi InventoryTransactions).
 *  - Đơn đã hoàn thành: khóa linh kiện / tiền công.
 *  - finalCost luôn do BE tính = laborCost + Σ(quantity × unitPrice), không tin số FE gửi.
 *  - Mỗi linh kiện có kèm ảnh (image) để FE hiển thị.
 * ===================================================================================== */

export const MAX_PARTS = 30;
export const MAX_QTY = 9999;

// Lỗi nghiệp vụ -> handleError trả 400
export const bizError = (message) => {
    const e = new Error(message);
    e.isBusiness = true;
    return e;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const variantLabel = (product, variant) => {
    const attrs = (variant.attributes || []).map((a) => a.value).filter(Boolean).join(" / ");
    return attrs ? `${product.name} (${attrs})` : product.name;
};

// Giá bán hiệu lực hiện tại của biến thể.
// LƯU Ý: chỉnh lại tên trường cho khớp getPriceInfo() trong pricingModel của bạn.
const currentUnitPrice = (variant, product) => {
    try {
        const info = variant.getPriceInfo(product);
        return Number(info?.finalPrice ?? info?.salePrice ?? info?.price ?? 0) || 0;
    } catch {
        return 0;
    }
};

const available = (inv) => (inv ? Math.max(0, inv.quantity - inv.reservedQuantity) : 0);

// Ảnh của biến thể (variant.image.url); không có thì lấy ảnh đầu tiên của sản phẩm (product.images[].url)
const pickImage = (variant, product) =>
    variant?.image?.url || product?.images?.find((i) => i?.url)?.url || "";

/* ----------------------------- 1. Danh sách linh kiện để chọn ----------------------------- */

// Trả về [{ value (variantId), label, sku, price, stock, image }]
export const getPartOptions = async ({ search, category, limit = 20 }) => {
    const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const filter = { deletedAt: null, status: "active" };
    if (category && mongoose.isValidObjectId(category)) filter.category = category;

    const keyword = String(search || "").trim();
    if (keyword) {
        const re = new RegExp(escapeRegex(keyword), "i");
        const bySku = await ProductVariants.find({ sku: re, isActive: true }).select("product").limit(50);
        filter.$or = [{ name: re }, { _id: { $in: bySku.map((v) => v.product) } }];
    }

    const products = await Products.find(filter).select("name pricing images").sort({ name: 1 }).limit(max);
    if (!products.length) return [];

    const variants = await ProductVariants.find({
        product: { $in: products.map((p) => p._id) },
        isActive: true,
    });
    const inventories = await Inventory.find({
        variant: { $in: variants.map((v) => v._id) },
        isActive: true,
    });

    const productMap = new Map(products.map((p) => [String(p._id), p]));
    const invMap = new Map(inventories.map((i) => [String(i.variant), i]));

    return variants
        .filter((v) => invMap.has(String(v._id))) // chỉ biến thể có quản lý tồn kho
        .map((v) => {
            const product = productMap.get(String(v.product));
            return {
                value: String(v._id),
                label: variantLabel(product, v),
                sku: v.sku,
                price: currentUnitPrice(v, product),
                stock: available(invMap.get(String(v._id))),
                image: pickImage(v, product),
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label, "vi"));
};

/* ----------------------------- 2. Kiểm tra & dựng danh sách linh kiện ----------------------------- */

// rawParts: [{ variantId | productId, quantity | qty, unitPrice? }]
// Trả về mảng snapshot để gán vào doc.parts
export const buildParts = async (rawParts) => {
    if (!Array.isArray(rawParts)) throw bizError("Danh sách linh kiện không hợp lệ");
    if (rawParts.length > MAX_PARTS) throw bizError(`Tối đa ${MAX_PARTS} linh kiện cho mỗi đơn`);
    if (!rawParts.length) return [];

    const seen = new Set();
    const items = rawParts.map((raw) => {
        const variantId = String(raw?.variantId || raw?.productId || "");
        if (!mongoose.isValidObjectId(variantId)) throw bizError("Mã linh kiện không hợp lệ");
        if (seen.has(variantId)) throw bizError("Linh kiện bị trùng, hãy gộp thành một dòng");
        seen.add(variantId);

        const quantity = Number(raw.quantity ?? raw.qty);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
            throw bizError(`Số lượng linh kiện phải là số nguyên từ 1 đến ${MAX_QTY}`);
        }
        return { variantId, quantity, rawPrice: raw.unitPrice };
    });

    const ids = items.map((i) => i.variantId);
    const variants = await ProductVariants.find({ _id: { $in: ids }, isActive: true });
    const products = await Products.find({ _id: { $in: variants.map((v) => v.product) } }).select(
        "name pricing images"
    );
    const inventories = await Inventory.find({ variant: { $in: ids }, isActive: true });

    const variantMap = new Map(variants.map((v) => [String(v._id), v]));
    const productMap = new Map(products.map((p) => [String(p._id), p]));
    const invMap = new Map(inventories.map((i) => [String(i.variant), i]));

    return items.map(({ variantId, quantity, rawPrice }) => {
        const variant = variantMap.get(variantId);
        const product = variant && productMap.get(String(variant.product));
        if (!variant || !product) throw bizError("Có linh kiện không còn tồn tại hoặc đã ngừng bán");

        const name = variantLabel(product, variant);
        const stock = available(invMap.get(variantId));
        if (quantity > stock) throw bizError(`"${name}" chỉ còn ${stock} trong kho`);

        // Nhân viên được chỉnh đơn giá (giảm giá, giá nội bộ). Bỏ trống thì lấy giá hiện hành.
        let unitPrice;
        if (rawPrice === undefined || rawPrice === null || rawPrice === "") {
            unitPrice = currentUnitPrice(variant, product);
        } else {
            unitPrice = Number(rawPrice);
            if (!Number.isFinite(unitPrice) || unitPrice < 0) throw bizError(`Đơn giá của "${name}" không hợp lệ`);
        }
        unitPrice = Math.round(unitPrice);

        return {
            variant: variant._id,
            product: product._id,
            sku: variant.sku,
            name,
            image: pickImage(variant, product), // lưu ảnh vào đơn để dòng đã lưu luôn có ảnh
            quantity,
            unitPrice,
            lineTotal: quantity * unitPrice,
        };
    });
};

/* ----------------------------- 3. Áp linh kiện + tiền công lên doc ----------------------------- */

// Gọi trước doc.save() ở updateRepairInfo và updateRepairStatus.
// - Không gửi parts / laborCost: bỏ qua.
// - Đơn đã hoàn thành (hoặc đã xuất kho): bỏ qua, FE cũng đã khóa các ô này.
// - Có linh kiện hoặc tiền công: finalCost = laborCost + tổng linh kiện.
export const applyCostBreakdown = async (doc, body = {}) => {
    const hasParts = body.parts !== undefined;
    const hasLabor = body.laborCost !== undefined && body.laborCost !== "";
    if (!hasParts && !hasLabor) return;
    if (doc.status === "completed" || doc.stockDeducted) return;

    if (hasParts) doc.parts = await buildParts(body.parts);

    if (hasLabor) {
        const labor = Number(body.laborCost);
        if (!Number.isFinite(labor) || labor < 0) throw bizError("Tiền công không hợp lệ");
        doc.laborCost = Math.round(labor);
    }

    const partsTotal = (doc.parts || []).reduce((s, p) => s + p.quantity * p.unitPrice, 0);
    const labor = doc.laborCost || 0;
    if ((doc.parts || []).length > 0 || labor > 0) {
        doc.finalCost = labor + partsTotal;
    }
};

/* ----------------------------- 4. Xuất kho khi hoàn thành ----------------------------- */

// Hoàn lại kho (dùng khi lỗi giữa chừng hoặc doc.save() thất bại sau khi đã trừ)
export const restoreParts = async (ctx) => {
    if (!ctx) return;
    for (const { before, part } of ctx.done) {
        await Inventory.updateOne({ _id: before._id }, { $inc: { quantity: part.quantity } });
    }
    if (ctx.txIds?.length) await InventoryTransactions.deleteMany({ _id: { $in: ctx.txIds } });
};

// Trừ kho từng linh kiện bằng cập nhật có điều kiện (tránh bán vượt khi 2 người cùng thao tác).
// Trả về ctx để restoreParts dùng nếu cần.
export const deductParts = async (doc, userId) => {
    const done = [];
    try {
        for (const part of doc.parts) {
            const before = await Inventory.findOneAndUpdate(
                {
                    variant: part.variant,
                    isActive: true,
                    $expr: { $gte: [{ $subtract: ["$quantity", "$reservedQuantity"] }, part.quantity] },
                },
                { $inc: { quantity: -part.quantity } },
                { new: false } // lấy bản TRƯỚC khi trừ để ghi before/after
            );
            if (!before) throw bizError(`"${part.name}" không đủ tồn kho để xuất`);
            done.push({ before, part });
        }

        const txs = await InventoryTransactions.insertMany(
            done.map(({ before, part }) => ({
                variant: part.variant,
                product: part.product,
                inventory: before._id,
                type: "export",
                quantity: -part.quantity,
                beforeQuantity: before.quantity,
                afterQuantity: before.quantity - part.quantity,
                beforeReservedQuantity: before.reservedQuantity,
                afterReservedQuantity: before.reservedQuantity,
                note: `Xuất linh kiện cho đơn sửa chữa ${doc.requestCode}`,
                refRepair: doc._id,
                createdBy: userId || null,
            }))
        );
        return { done, txIds: txs.map((t) => t._id) };
    } catch (err) {
        await restoreParts({ done });
        throw err;
    }
};