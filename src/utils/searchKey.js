import mongoose from 'mongoose';
import { normalize } from './text.js';

/**
 * searchKey = tên + thương hiệu + danh mục + tags (đã bỏ dấu, viết thường).
 * Dùng mongoose.model(...) tại thời điểm chạy để tránh import vòng giữa các model.
 */
export const buildSearchKey = async ({ name, brand, category, tags }) => {
  const [brandDoc, categoryDoc] = await Promise.all([
    brand ? mongoose.model('Brands').findById(brand).select('name').lean() : null,
    category ? mongoose.model('Categorys').findById(category).select('name').lean() : null,
  ]);

  return normalize([name, brandDoc?.name, categoryDoc?.name, ...(tags || [])].filter(Boolean).join(' '));
};