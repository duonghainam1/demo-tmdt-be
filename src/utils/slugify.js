export const toSlug = (str) =>
  str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export const generateUniqueSlug = async (baseText, Model, { session, excludeId } = {}) => {
  const base = toSlug(baseText);
  let slug = base;
  let counter = 1;
  while (true) {
    const filter = { slug };
    if (excludeId) filter._id = { $ne: excludeId };
    const query = Model.exists(filter);
    if (session) query.session(session);
    const exists = await query;
    if (!exists) return slug;
    slug = `${base}-${counter}`;
    counter += 1;
  }
};
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
