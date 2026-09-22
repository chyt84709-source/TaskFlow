import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, getCurrencyMeta, normalizeCountry } from '../config/database.js';
import { requireUser } from '../utils/helpers.js';

const router = express.Router();

router.get('/api/health', (_req, res) => res.json({ ok: true, service: 'taskflow', time: new Date().toISOString() }));

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

router.post('/api/premium/upgrade', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ tier: z.enum(['standard', 'premium']).default('premium') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid premium tier request' });

    await db.query('UPDATE users SET subscription_tier = $1 WHERE id = $2', [parsed.data.tier, req.session.user.id]);
    req.session.user.subscriptionTier = parsed.data.tier;
    res.json({ ok: true, tier: parsed.data.tier });
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
      avatarUrl: z.string().url().max(500).optional(),
      skills: z.string().max(500).optional(),
      phone: z.string().max(20).optional(),
      subscriptionTier: z.enum(['standard', 'premium']).optional(),
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: 'Invalid profile update' });

    const values = parsed.data;
    if (values.name) await db.query('UPDATE users SET name=$1 WHERE id=$2', [values.name, req.session.user.id]);
    if (values.phone) await db.query('UPDATE users SET phone=$1 WHERE id=$2', [values.phone, req.session.user.id]);
    if (values.country) await db.query('UPDATE users SET country=$1 WHERE id=$2', [normalizeCountry(values.country), req.session.user.id]);
    if (values.subscriptionTier) await db.query('UPDATE users SET subscription_tier=$1 WHERE id=$2', [values.subscriptionTier, req.session.user.id]);
    if (values.avatarUrl) await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [values.avatarUrl, req.session.user.id]);

    await db.query(`INSERT INTO profiles (id, user_id, bio, location, avatar_url, skills, social_links, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, location = EXCLUDED.location, avatar_url = EXCLUDED.avatar_url, skills = EXCLUDED.skills`, [nanoid(), req.session.user.id, values.bio || null, values.location || null, values.avatarUrl || null, values.skills || null, JSON.stringify({}), new Date().toISOString()]);

    req.session.user.name = values.name || req.session.user.name;
    req.session.user.country = normalizeCountry(values.country || req.session.user.country || 'US');
    req.session.user.subscriptionTier = values.subscriptionTier || req.session.user.subscriptionTier || 'standard';
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

router.post('/api/uploads', requireUser, async (req, res) => {
  res.status(501).json({ error: 'Upload middleware is attached in the server entrypoint.' });
});

export default router;
