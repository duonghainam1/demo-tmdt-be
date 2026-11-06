/**
 * Lỗi nghiệp vụ có mã HTTP, được `handle` (utils/handle.js) chuyển thành response JSON.
 * Mọi service dùng chung class này thay vì import từ service khác.
 */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}