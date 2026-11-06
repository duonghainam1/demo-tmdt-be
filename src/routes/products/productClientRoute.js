import { Router } from 'express';
import productClientController from '../../controllers/product/productClientController.js';

const router = Router();

// GET /api/products?store=HN01&category=op-lung&brand=spigen,uag&minPrice=100000&maxPrice=500000
//   &attributes[mau-sac]=do,xanh&attributes[chat-lieu]=silicon&sort=price_asc&page=1&limit=12
router.get('/best-sellers', productClientController.getBestSellers);
router.get('/search', productClientController.searchProducts);
router.get('/accessories/:slug', productClientController.getAccessories);
router.get('/:category', productClientController.getProducts);
router.get('/detail/:slug', productClientController.getProductDetail);
router.get('/related/:slug', productClientController.getRelatedProducts);
export default router;