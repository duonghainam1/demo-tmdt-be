import { HttpError } from '../httpError.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
export const isObjectId = (v) => typeof v === 'string' && OBJECT_ID_RE.test(v);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

// Giới hạn độ dài (khớp với model và với phần hiển thị ở trang chủ)
const NAME_MAX = 150;
const SUBTITLE_MAX = 60;

function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function throwIfErrors(errors) {
  if (errors.length) throw new HttpError(400, 'Dữ liệu không hợp lệ', errors);
}

/**
 * Phụ đề của đợt (hiển thị dưới tiêu đề ở trang chủ).
 *  - undefined (không gửi)  -> trả undefined: giữ nguyên giá trị cũ
 *  - null hoặc chuỗi rỗng   -> trả '': xóa phụ đề (trang chủ sẽ ẩn dòng phụ đề)
 *  - chuỗi                  -> trim, tối đa SUBTITLE_MAX ký tự
 * Lỗi được đẩy vào mảng errors và trả undefined.
 */
function parseSubtitle(value, errors) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') {
    errors.push({ field: 'subtitle', message: 'subtitle phải là chuỗi' });
    return undefined;
  }
  const s = value.trim();
  if (s.length > SUBTITLE_MAX) {
    errors.push({ field: 'subtitle', message: `subtitle tối đa ${SUBTITLE_MAX} ký tự` });
    return undefined;
  }
  return s;
}

export function validateObjectId(value, field = 'id') {
  if (!isObjectId(value)) throw new HttpError(400, `${field} không hợp lệ`);
  return value;
}

/* ---------------------------- Đợt flash sale ---------------------------- */

export function validateCreateFlashSale(body) {
  const errors = [];
  if (!isPlainObject(body)) throw new HttpError(400, 'Body không hợp lệ');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) {
    errors.push({ field: 'name', message: `name bắt buộc, tối đa ${NAME_MAX} ký tự` });
  }

  const subtitle = parseSubtitle(body.subtitle, errors);

  const startTime = parseDate(body.startTime);
  const endTime = parseDate(body.endTime);
  if (!startTime) errors.push({ field: 'startTime', message: 'startTime không hợp lệ' });
  if (!endTime) errors.push({ field: 'endTime', message: 'endTime không hợp lệ' });
  if (startTime && endTime) {
    if (endTime <= startTime) errors.push({ field: 'endTime', message: 'endTime phải sau startTime' });
    if (endTime <= new Date()) errors.push({ field: 'endTime', message: 'endTime phải ở tương lai' });
  }

  throwIfErrors(errors);
  // Không gửi subtitle thì không đưa vào (để trang chủ dùng câu mặc định)
  return { name, startTime, endTime, ...(subtitle !== undefined && { subtitle }) };
}

export function validateUpdateFlashSale(body) {
  const errors = [];
  if (!isPlainObject(body)) throw new HttpError(400, 'Body không hợp lệ');
  const data = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) {
      errors.push({ field: 'name', message: `name tối đa ${NAME_MAX} ký tự, không được rỗng` });
    } else data.name = name;
  }
  if (body.subtitle !== undefined) {
    const subtitle = parseSubtitle(body.subtitle, errors);
    if (subtitle !== undefined) data.subtitle = subtitle;
  }
  if (body.startTime !== undefined) {
    const d = parseDate(body.startTime);
    if (!d) errors.push({ field: 'startTime', message: 'startTime không hợp lệ' });
    else data.startTime = d;
  }
  if (body.endTime !== undefined) {
    const d = parseDate(body.endTime);
    if (!d) errors.push({ field: 'endTime', message: 'endTime không hợp lệ' });
    else data.endTime = d;
  }

  if (!errors.length && Object.keys(data).length === 0) {
    errors.push({ field: '_', message: 'Không có trường nào để cập nhật' });
  }
  throwIfErrors(errors);
  return data;
}

export function validateListQuery(query) {
  const phases = ['draft', 'upcoming', 'running', 'ended', 'cancelled'];
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const phase = query.phase;
  if (phase !== undefined && !phases.includes(phase)) {
    throw new HttpError(400, `phase phải thuộc: ${phases.join(', ')}`);
  }
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
  return { page, limit, phase, search };
}

/* ------------------------------ Item ------------------------------ */

function checkItemFields(item, prefix, errors, { partial }) {
  const out = {};
  const f = (name) => (prefix ? `${prefix}.${name}` : name);

  if (!partial) {
    if (!isObjectId(item.variantId)) errors.push({ field: f('variantId'), message: 'variantId không hợp lệ' });
    else out.variantId = item.variantId;
  }

  if (!partial || item.flashPrice !== undefined) {
    if (!isInt(item.flashPrice) || item.flashPrice <= 0) {
      errors.push({ field: f('flashPrice'), message: 'flashPrice phải là số nguyên VND > 0' });
    } else out.flashPrice = item.flashPrice;
  }
  if (!partial || item.quota !== undefined) {
    if (!isInt(item.quota) || item.quota < 1) {
      errors.push({ field: f('quota'), message: 'quota phải là số nguyên >= 1' });
    } else out.quota = item.quota;
  }
  if (item.limitPerUser !== undefined) {
    if (!isInt(item.limitPerUser) || item.limitPerUser < 0) {
      errors.push({ field: f('limitPerUser'), message: 'limitPerUser phải là số nguyên >= 0 (0 = không giới hạn)' });
    } else out.limitPerUser = item.limitPerUser;
  } else if (!partial) {
    out.limitPerUser = 0;
  }
  return out;
}

export function validateAddItems(body) {
  const errors = [];
  if (!isPlainObject(body) || !Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, 'items phải là mảng không rỗng');
  }
  if (body.items.length > 100) throw new HttpError(400, 'Tối đa 100 item mỗi lần');

  const items = body.items.map((it, i) => {
    if (!isPlainObject(it)) {
      errors.push({ field: `items.${i}`, message: 'item không hợp lệ' });
      return null;
    }
    return checkItemFields(it, `items.${i}`, errors, { partial: false });
  });
  throwIfErrors(errors);
  return items;
}

export function validateUpdateItem(body) {
  const errors = [];
  if (!isPlainObject(body)) throw new HttpError(400, 'Body không hợp lệ');
  const data = checkItemFields(body, '', errors, { partial: true });

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push({ field: 'isActive', message: 'isActive phải là boolean' });
    else data.isActive = body.isActive;
  }
  if (!errors.length && Object.keys(data).length === 0) {
    errors.push({ field: '_', message: 'Không có trường nào để cập nhật' });
  }
  throwIfErrors(errors);
  return data;
}

/* ----------------------------- Public ----------------------------- */

export function validatePublicQuery(query, { defaultLimit = 8 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit };
}