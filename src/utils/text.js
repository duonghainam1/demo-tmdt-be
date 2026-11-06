// Bỏ dấu tiếng Việt + viết thường + gọn khoảng trắng
// "Ốp Lưng  iPhone" -> "op lung iphone"
export const normalize = (s = '') =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();

// Escape ký tự đặc biệt để đưa chuỗi người dùng nhập vào RegExp an toàn
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');