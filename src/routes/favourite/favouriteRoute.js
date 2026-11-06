import express from 'express';
import authMiddleware from '../../middlewares/authMiddleware.js';
import {
  addFavourite,
  removeFavourite,
  toggleFavourite,
  getMyFavourites,
  checkFavourites,
  clearFavourites,
  getFavouriteIds,
} from '../../controllers/favourite/favouriteController.js';

const router = express.Router();

router.use(authMiddleware); // req.user phải có sau bước này

router.get('/', getMyFavourites);
router.get('/ids', getFavouriteIds);
router.delete('/', clearFavourites);
router.post('/check', checkFavourites);
router.post('/:productId', addFavourite);
router.post('/:productId/toggle', toggleFavourite);
router.delete('/:productId', removeFavourite);

export default router;
// app.use('/api/favourites', favouriteRoutes);