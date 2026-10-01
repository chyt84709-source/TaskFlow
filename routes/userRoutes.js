import express from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, getCurrencyMeta, getRegionalPaymentMethods, normalizeCountry } from '../config/database.js';
import { requireAdmin, requireUser } from '../utils/helpers.js';
import accountRoutes from './user/accountRoutes.js';
import conversationRoutes from './user/conversationRoutes.js';
import walletRoutes from './user/walletRoutes.js';
import mediaRoutes from './user/mediaRoutes.js';
import premiumRoutes from './user/premiumRoutes.js';
import profileRoutes from './user/profileRoutes.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const router = express.Router();
router.use(accountRoutes);
router.use(conversationRoutes);
router.use(walletRoutes);
router.use(mediaRoutes);
router.use(premiumRoutes);
router.use(profileRoutes);

export default router;
