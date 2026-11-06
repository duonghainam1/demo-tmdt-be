import * as svc from '../../services/flashSales/flashSaleService.js';
import {
  validateObjectId,
  validateCreateFlashSale,
  validateUpdateFlashSale,
  validateListQuery,
  validateAddItems,
  validateUpdateItem,
  validatePublicQuery,
} from '../../utils/validators/flashSaleValidator.js';
import { HttpError } from '../../utils/httpError.js';

// Bọc async handler: HttpError trả về đúng status, lỗi khác đẩy cho error middleware chung.
const handle = (fn) => (req, res, next) =>
  fn(req, res).catch((err) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.message, errors: err.details });
    }
    return next(err);
  });

/* ------------------------------ Public ------------------------------ */

// GET /flash-sales/current?page=&limit=
export const getCurrent = handle(async (req, res) => {
  const q = validatePublicQuery(req.query, { defaultLimit: 8 });
  const data = await svc.getCurrentFlashSale(q);
  res.json({ success: true, data });
});

// GET /flash-sales/:id/products?page=&limit=
export const getProducts = handle(async (req, res) => {
  const saleId = validateObjectId(req.params.id, 'id');
  const q = validatePublicQuery(req.query, { defaultLimit: 20 });
  const data = await svc.getFlashSaleProducts({ saleId, ...q });
  res.json({ success: true, data });
});

/* ------------------------------- Admin ------------------------------- */

export const list = handle(async (req, res) => {
  const data = await svc.listFlashSales(validateListQuery(req.query));
  res.json({ success: true, data });
});

export const detail = handle(async (req, res) => {
  const data = await svc.getFlashSaleDetail(validateObjectId(req.params.id, 'id'));
  res.json({ success: true, data });
});

export const create = handle(async (req, res) => {
  const body = validateCreateFlashSale(req.body);
  const data = await svc.createFlashSale(body, req.user?._id ?? null);
  res.status(201).json({ success: true, data });
});

export const update = handle(async (req, res) => {
  const id = validateObjectId(req.params.id, 'id');
  const data = await svc.updateFlashSale(id, validateUpdateFlashSale(req.body));
  res.json({ success: true, data });
});

export const publish = handle(async (req, res) => {
  const data = await svc.publishFlashSale(validateObjectId(req.params.id, 'id'));
  res.json({ success: true, data });
});

export const cancel = handle(async (req, res) => {
  const data = await svc.cancelFlashSale(validateObjectId(req.params.id, 'id'));
  res.json({ success: true, data });
});

export const endNow = handle(async (req, res) => {
  const data = await svc.endFlashSaleNow(validateObjectId(req.params.id, 'id'));
  res.json({ success: true, data });
});

/**
 * GET /admin/flash-sales/:id/available-variants?search=&page=&limit=
 * Danh sách biến thể có thể thêm vào đợt (cấp dữ liệu cho form "Thêm sản phẩm vào đợt giờ vàng").
 */
export const availableVariants = handle(async (req, res) => {
  const id = validateObjectId(req.params.id, 'id');
  const { page, limit } = validatePublicQuery(req.query, { defaultLimit: 50 });
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const data = await svc.listAvailableVariants(id, { search, page, limit });
  res.json({ success: true, data });
});

export const addItems = handle(async (req, res) => {
  const id = validateObjectId(req.params.id, 'id');
  const result = await svc.addItems(id, validateAddItems(req.body));
  // Không thêm được item nào -> 422; thêm được một phần vẫn 201 kèm danh sách lỗi
  const status = result.created.length ? 201 : 422;
  res.status(status).json({ success: result.created.length > 0, data: result });
});

export const updateItem = handle(async (req, res) => {
  const id = validateObjectId(req.params.id, 'id');
  const itemId = validateObjectId(req.params.itemId, 'itemId');
  const data = await svc.updateItem(id, itemId, validateUpdateItem(req.body));
  res.json({ success: true, data });
});

export const removeItem = handle(async (req, res) => {
  const id = validateObjectId(req.params.id, 'id');
  const itemId = validateObjectId(req.params.itemId, 'itemId');
  await svc.removeItem(id, itemId);
  res.json({ success: true });
});