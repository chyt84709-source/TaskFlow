import express from 'express';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, getCurrencyMeta, getRegionalPaymentMethods, normalizeCountry } from '../../config/database.js';
import { requireUser } from '../../utils/helpers.js';

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

router.get('/api/me', async (req, res, next) => {
  if (!req.session.user || req.session.user.isAdmin || req.session.user.role === 'admin') return res.json({ user: req.session.user || null });
  try {
    const result = await db.query('SELECT account_status,subscription_tier,green_tick,name,email,role,country,avatar_url AS "avatarUrl" FROM users WHERE id=$1', [req.session.user.id]);
    if (result.rows[0]?.account_status !== 'active') {
      req.session = null;
      return res.json({ user: null });
    }
    req.session.user = {
      ...req.session.user,
      name: result.rows[0].name || req.session.user.name,
      email: result.rows[0].email || req.session.user.email || null,
      role: result.rows[0].role || req.session.user.role,
      country: normalizeCountry(result.rows[0].country || req.session.user.country || 'US'),
      avatarUrl: result.rows[0].avatarUrl || null,
      avatar_url: result.rows[0].avatarUrl || null,
      subscriptionTier: result.rows[0].subscription_tier || 'standard',
      greenTick: result.rows[0].subscription_tier === 'premium' && Boolean(result.rows[0].green_tick)
    };
    res.json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.get('/api/notifications', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT id,kind,body,read_at AS "readAt",created_at AS "createdAt"
      FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.session.user.id]);
    res.json({ notifications: result.rows, unreadCount: result.rows.filter((item) => !item.readAt).length });
  } catch (error) {
    next(error);
  }
});

router.post('/api/notifications/:id/read', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ updated: true });
  } catch (error) {
    next(error);
  }
});

router.post('/api/notifications/read-all', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL', [req.session.user.id]);
    res.json({ updated: true, count: result.rowCount });
  } catch (error) {
    next(error);
  }
});

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

export default router;
