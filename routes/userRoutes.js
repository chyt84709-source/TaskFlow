import express from 'express';
import multer from 'multer';
import Stripe from 'stripe';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, getCurrencyMeta, getRegionalPaymentMethods, hash, issueOtp, normalizeCountry, reqOtp } from '../config/database.js';
import { requireUser } from '../utils/helpers.js';
import { decryptImage, processAndEncryptImage, readEncryptedImage, saveEncryptedImage } from '../services/media.js';

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif|avif|heic)$/.test(file.mimetype)) });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

async function verifyTurnstile(token, remoteIp) {
  if (!process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY) return false;
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp || '' }),
  });
  const result = await response.json();
  return result.success === true;
}

async function sendCardOtp(email, code) {
  if (!process.env.RESEND_API_KEY || !email) throw new Error('Email verification is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${process.env.RESEND_FROM_NAME || 'TaskFlow'} <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
      to: [email],
      subject: 'Confirm your TaskFlow payment method',
      html: `<p>Your TaskFlow card verification code is <strong>${code}</strong>.</p><p>This code expires in ten minutes.</p>`,
    }),
  });
  if (!response.ok) throw new Error('Unable to send card verification email.');
}

const router = express.Router();

router.get('/api/health', (_req, res) => res.json({ ok: true, service: 'taskflow', time: new Date().toISOString() }));

router.get('/api/client-config', (_req, res) => res.json({ turnstileSiteKey: process.env.CLOUDFLARE_TURNSTILE_SITE_KEY || '', stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' }));

router.get('/api/summary', async (_req, res, next) => {
  try {
    const [users, tasks, listings, paid] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS count FROM users'),
      db.query("SELECT COUNT(*)::int AS count FROM tasks WHERE status='active'"),
      db.query("SELECT COUNT(*)::int AS count FROM listings WHERE status='active'"),
      db.query('SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM transactions WHERE amount_cents > 0'),
    ]);

    res.json({ users: users.rows[0].count, activeTasks: tasks.rows[0].count, activeListings: listings.rows[0].count, paidCents: paid.rows[0].total });
  } catch (error) {
    next(error);
  }
});

router.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

router.get('/api/currency', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT country, subscription_tier FROM users WHERE id = $1', [req.session.user.id]);
    const country = normalizeCountry(result.rows[0]?.country || req.session.user.country || 'US');
    const meta = getCurrencyMeta(country);
    res.json({ country, code: meta.code, symbol: meta.symbol, rate: meta.rate });
  } catch (error) {
    next(error);
  }
});

router.get('/api/payment-options', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]);
    const country = normalizeCountry(result.rows[0]?.country || req.session.user.country || 'US');
    const tax = calculateInternationalTax(500, country);
    res.json({ country, paymentMethods: getRegionalPaymentMethods(country), internationalTaxRate: tax.taxRate, taxesApply: tax.isInternational });
  } catch (error) {
    next(error);
  }
});

router.get('/api/referrals', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT referral_code AS "referralCode", referral_count AS "referralCount", subscription_tier AS "subscriptionTier", green_tick AS "greenTick" FROM users WHERE id = $1', [req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    let referralCode = result.rows[0].referralCode;
    if (!referralCode) {
      referralCode = nanoid(16);
      await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [referralCode, req.session.user.id]);
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ referralCode, referralCount: Number(result.rows[0].referralCount || 0), subscriptionTier: result.rows[0].subscriptionTier, greenTick: Boolean(result.rows[0].greenTick), referralUrl: `${origin}/?ref=${encodeURIComponent(referralCode)}` });
  } catch (error) {
    next(error);
  }
});

router.get('/api/wallet/cards', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT id,holder_name,card_type,card_brand,last4,expiry,created_at FROM wallet_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
    res.json({ cards: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/wallet/cards', requireUser, (_req, res) => res.status(410).json({ error: 'Direct card attachment is disabled. Request and confirm the email OTP first.' }));

router.post('/api/wallet/cards/request-verification', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      holderName: z.string().min(2).max(120),
      cardType: z.enum(['credit', 'debit']),
      turnstileToken: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter valid Credit or Debit card details and complete the security check.' });
    if (!(await verifyTurnstile(parsed.data.turnstileToken, req.ip))) return res.status(403).json({ error: 'Cloudflare security verification failed.' });

    const userResult = await db.query('SELECT email FROM users WHERE id=$1', [req.session.user.id]);
    const email = userResult.rows[0]?.email;
    if (!email) return res.status(400).json({ error: 'Add an email address to your profile before verifying a card.' });
    if (!stripe) return res.status(503).json({ error: 'Stripe card verification is not configured.' });
    const verificationId = nanoid();
    const setupIntent = await stripe.setupIntents.create({ payment_method_types: ['card'], usage: 'off_session', metadata: { verificationId, userId: req.session.user.id } });
    await db.query('INSERT INTO wallet_card_verifications (id,user_id,holder_name,card_type,card_brand,last4,expiry,setup_intent_id,otp_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [verificationId, req.session.user.id, parsed.data.holderName.trim(), parsed.data.cardType, 'pending', '0000', '00/00', setupIntent.id, 'setup-pending', new Date(Date.now() + 10 * 60 * 1000).toISOString()]);
    res.status(202).json({ verificationId, clientSecret: setupIntent.client_secret, message: 'Enter your card in the secure Stripe form.' });
  } catch (error) {
    next(error);
  }
});

router.post('/api/wallet/cards/confirm-setup', requireUser, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe card verification is not configured.' });
    const parsed = z.object({ verificationId: z.string().min(10), paymentMethodId: z.string().startsWith('pm_') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A valid Stripe payment method is required.' });
    const pendingResult = await db.query('SELECT * FROM wallet_card_verifications WHERE id=$1 AND user_id=$2', [parsed.data.verificationId, req.session.user.id]);
    const pending = pendingResult.rows[0];
    if (!pending || new Date(pending.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Card verification request expired.' });
    const setupIntent = await stripe.setupIntents.retrieve(pending.setup_intent_id);
    if (setupIntent.status !== 'succeeded' || setupIntent.payment_method !== parsed.data.paymentMethodId) return res.status(400).json({ error: 'Stripe card setup was not completed.' });
    const paymentMethod = await stripe.paymentMethods.retrieve(parsed.data.paymentMethodId);
    if (paymentMethod.type !== 'card' || !paymentMethod.card) return res.status(400).json({ error: 'Only Credit or Debit cards are supported.' });
    const funding = paymentMethod.card.funding;
    if (funding !== pending.card_type) return res.status(400).json({ error: 'The selected card type does not match the card. Prepaid cards are not supported.' });
    const expiry = `${String(paymentMethod.card.exp_month).padStart(2, '0')}/${String(paymentMethod.card.exp_year).slice(-2)}`;
    await db.query('UPDATE wallet_card_verifications SET card_brand=$1,last4=$2,expiry=$3 WHERE id=$4', [paymentMethod.card.brand, paymentMethod.card.last4, expiry, pending.id]);
    const userResult = await db.query('SELECT email FROM users WHERE id=$1', [req.session.user.id]);
    const code = issueOtp(`wallet-card:${pending.id}`);
    await db.query('UPDATE wallet_card_verifications SET otp_hash=$1 WHERE id=$2', [hash(code), pending.id]);
    await sendCardOtp(userResult.rows[0]?.email, code);
    res.status(202).json({ message: 'A verification code was sent to your email.' });
  } catch (error) {
    next(error);
  }
});

router.post('/api/wallet/cards/confirm-verification', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ verificationId: z.string().min(10), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter the six-digit verification code.' });
    const result = await db.query('SELECT * FROM wallet_card_verifications WHERE id=$1 AND user_id=$2', [parsed.data.verificationId, req.session.user.id]);
    const pending = result.rows[0];
    const record = reqOtp.get(`wallet-card:${parsed.data.verificationId}`);
    if (!pending || !record || new Date(pending.expires_at).getTime() < Date.now() || !record.has(hash(parsed.data.code)) || record.get(hash(parsed.data.code)) < Date.now()) return res.status(401).json({ error: 'Invalid or expired card verification code.' });
    await db.query('INSERT INTO wallet_cards (id,user_id,holder_name,card_type,card_brand,last4,expiry,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [nanoid(), pending.user_id, pending.holder_name, pending.card_type, pending.card_brand, pending.last4, pending.expiry, new Date().toISOString()]);
    await db.query('DELETE FROM wallet_card_verifications WHERE id=$1', [pending.id]);
    reqOtp.delete(`wallet-card:${parsed.data.verificationId}`);
    res.status(201).json({ ok: true, message: 'Payment method verified and added.' });
  } catch (error) {
    next(error);
  }
});

router.post('/api/profile/avatar', requireUser, imageUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'An image file is required.' });
    const image = await processAndEncryptImage(req.file.buffer);
    const id = nanoid();
    const filename = await saveEncryptedImage(image.payload, id);
    await db.query('INSERT INTO media_files (id,user_id,filename,mime_type,purpose) VALUES ($1,$2,$3,$4,$5)', [id, req.session.user.id, filename, image.mimeType, 'profile-avatar']);
    const avatarUrl = `/api/media/${id}`;
    await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [avatarUrl, req.session.user.id]);
    res.status(201).json({ url: avatarUrl, mimeType: image.mimeType });
  } catch (error) {
    next(error);
  }
});

router.get('/api/media/:id', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT filename,mime_type AS "mimeType",purpose,user_id AS "userId" FROM media_files WHERE id=$1', [req.params.id]);
    const media = result.rows[0];
    const sharedMedia = media?.purpose === 'marketplace-media' || media?.purpose === 'ad-media';
    if (!media || (!sharedMedia && media.userId !== req.session.user.id)) return res.status(404).end();
    try {
      const encrypted = await readEncryptedImage(media.filename);
      res.type(media.mimeType).send(decryptImage(encrypted));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).end();
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

router.post('/api/premium/upgrade', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ method: z.enum(['fee', 'referrals']).default('fee') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid premium tier request' });

    const userResult = await db.query('SELECT country, subscription_tier, referral_count FROM users WHERE id = $1', [req.session.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.subscription_tier === 'premium') return res.json({ ok: true, tier: 'premium', source: 'already-active' });

    const country = normalizeCountry(user.country || req.session.user.country || 'US');
    const meta = getCurrencyMeta(country);
    const premiumBaseCents = Math.round(500 * meta.rate);
    const premiumTax = calculateInternationalTax(premiumBaseCents, country);
    const premiumFeeCents = premiumBaseCents + premiumTax.taxCents;
    if (parsed.data.method === 'referrals') {
      if (Number(user.referral_count || 0) < 10) return res.status(400).json({ error: 'Complete 10 verified referrals to unlock Premium.' });
    } else {
      const balanceResult = await db.query("SELECT COALESCE(SUM(CASE WHEN kind IN ('payout', 'product_purchase', 'gig_purchase', 'task_purchase', 'marketplace_purchase', 'premium_upgrade') THEN -amount_cents ELSE amount_cents END), 0)::int AS balance FROM transactions WHERE user_id = $1 AND status IN ('paid', 'completed', 'approved', 'success')", [req.session.user.id]);
      if (Number(balanceResult.rows[0]?.balance || 0) < premiumFeeCents) return res.status(400).json({ error: `Add ${meta.symbol}${(premiumFeeCents / 100).toLocaleString()} to your wallet before upgrading.` });
      await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), req.session.user.id, 'premium_upgrade', premiumFeeCents, 'paid', { baseUsdCents: 500, currency: meta.code, rate: meta.rate, taxCents: premiumTax.taxCents, internationalTax: premiumTax.isInternational }, new Date().toISOString()]);
    }

    await db.query('UPDATE users SET subscription_tier = $1, premium_source = $2, premium_activated_at = $3 WHERE id = $4', ['premium', parsed.data.method, new Date().toISOString(), req.session.user.id]);
    req.session.user.subscriptionTier = 'premium';
    res.json({ ok: true, tier: 'premium', source: parsed.data.method, feeCents: parsed.data.method === 'fee' ? premiumFeeCents : 0, taxCents: parsed.data.method === 'fee' ? premiumTax.taxCents : 0, currency: meta.code, rate: meta.rate, benefits: ['Account boost', 'Premium profile badge', 'Marketplace discounts'] });
  } catch (error) {
    next(error);
  }
});

router.post('/api/premium/checkout', requireUser, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe payments are not configured.' });
    const userResult = await db.query('SELECT email, country, subscription_tier FROM users WHERE id=$1', [req.session.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.subscription_tier === 'premium') return res.json({ ok: true, tier: 'premium', alreadyActive: true });
    const country = normalizeCountry(user.country || req.session.user.country || 'US');
    const origin = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const tax = calculateInternationalTax(500, country);
    const paymentMethods = getRegionalPaymentMethods(country);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email || undefined,
      client_reference_id: req.session.user.id,
      payment_method_types: paymentMethods.length ? paymentMethods : ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'TaskFlow Premium membership', description: 'Account boost, Premium badge, and marketplace discounts.' }, unit_amount: 500 }, quantity: 1 }, ...(tax.taxCents ? [{ price_data: { currency: 'usd', product_data: { name: 'International transaction tax' }, unit_amount: tax.taxCents }, quantity: 1 }] : [])],
      metadata: { userId: req.session.user.id, baseUsdCents: '500', taxCents: String(tax.taxCents), country, paymentMethods: paymentMethods.join(',') },
      success_url: `${origin}/#premium&payment=success`,
      cancel_url: `${origin}/#premium&payment=cancelled`,
    });
    res.json({ ok: true, checkoutUrl: checkoutSession.url });
  } catch (error) {
    next(error);
  }
});

router.get('/api/profile', requireUser, async (req, res, next) => {
  try {
    const [userResult, profileResult] = await Promise.all([
      db.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]),
      db.query('SELECT * FROM profiles WHERE user_id=$1', [req.session.user.id]),
    ]);
    const user = userResult.rows[0];
    const profile = profileResult.rows[0] || null;
    res.json({ user: user ? { ...user, country: normalizeCountry(user.country || 'US'), profile } : null });
  } catch (error) {
    next(error);
  }
});

router.put('/api/profile', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      name: z.string().min(1).max(100).optional(),
      bio: z.string().max(500).optional(),
      location: z.string().max(120).optional(),
      country: z.string().max(80).optional(),
      avatarUrl: z.string().max(500).refine((value) => value.startsWith('/') || /^https?:\/\//.test(value), 'Invalid avatar URL').optional(),
      skills: z.string().max(500).optional(),
      phone: z.string().max(40).optional(),
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile update' });

    const values = parsed.data;
    if (values.name) await db.query('UPDATE users SET name=$1 WHERE id=$2', [values.name, req.session.user.id]);
    if (values.phone !== undefined) await db.query('UPDATE users SET phone=$1 WHERE id=$2', [values.phone || null, req.session.user.id]);
    if (values.country) await db.query('UPDATE users SET country=$1 WHERE id=$2', [normalizeCountry(values.country), req.session.user.id]);
    if (values.avatarUrl) await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [values.avatarUrl, req.session.user.id]);

    await db.query(`INSERT INTO profiles (id, user_id, bio, location, avatar_url, skills, social_links, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, location = EXCLUDED.location, avatar_url = EXCLUDED.avatar_url, skills = EXCLUDED.skills`, [nanoid(), req.session.user.id, values.bio || null, values.location || null, values.avatarUrl || null, values.skills || null, JSON.stringify({}), new Date().toISOString()]);

    req.session.user.name = values.name || req.session.user.name;
    req.session.user.country = normalizeCountry(values.country || req.session.user.country || 'US');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ products: [], listings: [], gigs: [], tasks: [] });

    const productQuery = await db.query('SELECT * FROM products WHERE LOWER(title) LIKE LOWER($1) OR LOWER(description) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]);
    const listingQuery = await db.query('SELECT * FROM listings WHERE LOWER(title) LIKE LOWER($1) OR LOWER(type) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]);
    const gigQuery = await db.query('SELECT * FROM gigs WHERE LOWER(title) LIKE LOWER($1) OR LOWER(description) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]);
    const taskQuery = await db.query('SELECT * FROM tasks WHERE LOWER(title) LIKE LOWER($1) OR LOWER(video_url) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]);
    res.json({ products: productQuery.rows, listings: listingQuery.rows, gigs: gigQuery.rows, tasks: taskQuery.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/favorites', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM favorites WHERE user_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
    res.json({ favorites: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/favorites', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ targetType: z.enum(['product', 'listing', 'gig']), targetId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid favorite payload' });

    await db.query('INSERT INTO favorites (id,user_id,target_type,target_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, target_type, target_id) DO NOTHING', [nanoid(), req.session.user.id, parsed.data.targetType, parsed.data.targetId, new Date().toISOString()]);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/api/offers', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM offers WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
    res.json({ offers: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content-offers', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      contentType: z.enum(['task', 'product', 'gig', 'listing']),
      contentId: z.string().min(1),
      amountCents: z.number().int().positive(),
      message: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose an item and enter a valid offer amount.' });

    const tableMap = {
      task: ['tasks', 'client_id'],
      product: ['products', 'vendor_id'],
      gig: ['gigs', 'seller_id'],
      listing: ['listings', 'seller_id'],
    };
    const [table, ownerColumn] = tableMap[parsed.data.contentType];
    const item = await db.query(`SELECT id, ${ownerColumn} AS owner_id FROM ${table} WHERE id = $1${parsed.data.contentType === 'task' || parsed.data.contentType === 'gig' || parsed.data.contentType === 'listing' ? " AND status = 'active'" : ''}`, [parsed.data.contentId]);
    const sellerId = item.rows[0]?.owner_id;
    if (!sellerId) return res.status(404).json({ error: 'This item is no longer available.' });
    if (sellerId === req.session.user.id) return res.status(400).json({ error: 'You cannot make an offer on your own item.' });

    const conversationId = nanoid();
    const offerId = nanoid();
    await db.query('INSERT INTO conversations (id,content_type,content_id,buyer_id,seller_id,offer_id,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [conversationId, parsed.data.contentType, parsed.data.contentId, req.session.user.id, sellerId, offerId, 'pending', new Date().toISOString()]);
    await db.query('INSERT INTO content_offers (id,content_type,content_id,buyer_id,seller_id,amount_cents,message,status,conversation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [offerId, parsed.data.contentType, parsed.data.contentId, req.session.user.id, sellerId, parsed.data.amountCents, parsed.data.message || null, 'pending', conversationId, new Date().toISOString()]);
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), sellerId, 'offer', `You received a new offer of ${(parsed.data.amountCents / 100).toFixed(2)} for your ${parsed.data.contentType}.`, new Date().toISOString()]);
    res.status(201).json({ offer: { id: offerId, conversationId, status: 'pending' } });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content/:contentType/:id/status', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(['active', 'sold']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid item status.' });
    const tableMap = { task: ['tasks', 'client_id'], product: ['products', 'vendor_id'], gig: ['gigs', 'seller_id'], listing: ['listings', 'seller_id'] };
    const [table, ownerColumn] = tableMap[req.params.contentType] || [];
    if (!table) return res.status(400).json({ error: 'Unsupported content type.' });
    const result = await db.query(`UPDATE ${table} SET status = $1 WHERE id = $2 AND ${ownerColumn} = $3`, [parsed.data.status, req.params.id, req.session.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Item not found or you are not the owner.' });
    res.json({ ok: true, status: parsed.data.status });
  } catch (error) {
    next(error);
  }
});

router.get('/api/content-offers', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT o.*, c.status AS conversation_status, u.name AS buyer_name, s.name AS seller_name
      FROM content_offers o
      JOIN conversations c ON c.id = o.conversation_id
      LEFT JOIN users u ON u.id = o.buyer_id
      LEFT JOIN users s ON s.id = o.seller_id
      WHERE o.buyer_id = $1 OR o.seller_id = $1 ORDER BY o.created_at DESC`, [req.session.user.id]);
    res.json({ offers: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content-offers/:id/respond', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ decision: z.enum(['accepted', 'rejected']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose accept or reject.' });
    const offer = await db.query('SELECT * FROM content_offers WHERE id = $1 AND seller_id = $2', [req.params.id, req.session.user.id]);
    if (!offer.rows[0]) return res.status(404).json({ error: 'Offer not found.' });
    const row = offer.rows[0];
    await db.query('UPDATE content_offers SET status = $1, responded_at = $2 WHERE id = $3', [parsed.data.decision, new Date().toISOString(), row.id]);
    await db.query('UPDATE conversations SET status = $1 WHERE id = $2', [parsed.data.decision === 'accepted' ? 'open' : 'rejected', row.conversation_id]);
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), row.buyer_id, 'offer', `Your offer was ${parsed.data.decision}.`, new Date().toISOString()]);
    res.json({ ok: true, status: parsed.data.decision, conversationId: row.conversation_id });
  } catch (error) {
    next(error);
  }
});

router.get('/api/conversations', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT c.*, o.amount_cents, o.status AS offer_status, u.name AS buyer_name, s.name AS seller_name
      FROM conversations c JOIN content_offers o ON o.id = c.offer_id
      LEFT JOIN users u ON u.id = c.buyer_id LEFT JOIN users s ON s.id = c.seller_id
      WHERE c.buyer_id = $1 OR c.seller_id = $1 ORDER BY c.created_at DESC`, [req.session.user.id]);
    res.json({ conversations: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/conversations/:id/messages', requireUser, async (req, res, next) => {
  try {
    const access = await db.query('SELECT id FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [req.params.id, req.session.user.id]);
    if (!access.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
    const result = await db.query('SELECT m.*, u.name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 ORDER BY m.created_at ASC', [req.params.id]);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/conversations/:id/messages', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Message cannot be empty.' });
    const access = await db.query('SELECT buyer_id, seller_id, status FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [req.params.id, req.session.user.id]);
    const conversation = access.rows[0];
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    if (conversation.status !== 'open') return res.status(409).json({ error: 'Accept the offer before starting the chat.' });
    const message = { id: nanoid(), threadId: req.params.id, senderId: req.session.user.id, body: parsed.data.body, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO messages (id,thread_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, message.threadId, message.senderId, message.body, message.createdAt]);
    const recipientId = conversation.buyer_id === req.session.user.id ? conversation.seller_id : conversation.buyer_id;
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), recipientId, 'message', 'You have a new marketplace message.', message.createdAt]);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.post('/api/offers', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ listingId: z.string().min(1), sellerId: z.string().min(1), amountCents: z.number().int().positive(), message: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid offer payload' });

    const offer = { id: nanoid(), listingId: parsed.data.listingId, buyerId: req.session.user.id, sellerId: parsed.data.sellerId, amountCents: parsed.data.amountCents, message: parsed.data.message || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO offers (id,listing_id,buyer_id,seller_id,amount_cents,message,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [offer.id, offer.listingId, offer.buyerId, offer.sellerId, offer.amountCents, offer.message, 'pending', offer.createdAt]);
    res.status(201).json({ offer });
  } catch (error) {
    next(error);
  }
});

export default router;
