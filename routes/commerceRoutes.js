import express from 'express';
import storeRoutes from './commerce/storeRoutes.js';
import productRoutes from './commerce/productRoutes.js';
import supportRoutes from './commerce/supportRoutes.js';
import checkoutRoutes from './commerce/checkoutRoutes.js';
import adRoutes from './commerce/adRoutes.js';
import marketplaceRoutes from './commerce/marketplaceRoutes.js';

const router = express.Router();
router.use(storeRoutes);
router.use(productRoutes);
router.use(supportRoutes);
router.use(checkoutRoutes);
router.use(adRoutes);
router.use(marketplaceRoutes);

export default router;
