import * as cartService from '../../services/cart/cartService.js';
import { handle } from '../../utils/handle.js';

// req.user.id do middleware xác thực gắn vào (lấy từ payload JWT)
const userId = (req) => req.user.id;

export const getCart = handle((req) => cartService.getCart(userId(req)));

// Body: { variantId, quantity? }
export const addItem = handle((req) => cartService.addItem(userId(req), req.body));

export const updateItem = handle((req) =>
  cartService.updateItem(userId(req), req.params.itemId, req.body)
);

export const setAllSelected = handle((req) =>
  cartService.setAllSelected(userId(req), req.body.selected)
);

export const removeItem = handle((req) => cartService.removeItem(userId(req), req.params.itemId));

export const clearCart = handle((req) => cartService.clearCart(userId(req)));

// Body: { code }  -> gắn voucher (mã công khai hoặc voucher trong ví) vào giỏ
export const applyVoucher = handle((req) => cartService.applyVoucher(userId(req), req.body.code));

export const removeVoucher = handle((req) => cartService.removeVoucher(userId(req)));