import express from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, getCurrencyMeta, getRegionalPaymentMethods, normalizeCountry } from '../../config/database.js';
import { requireAdmin, requireUser } from '../../utils/helpers.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

router.post('/api/premium/requests', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().max(500).default('I would like to be considered for Premium access.') }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid Premium request.' });
    const userResult = await db.query('SELECT referral_count,subscription_tier FROM users WHERE id=$1', [req.session.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.subscription_tier === 'premium') return res.json({ requested: true, status: 'approved', tier: 'premium' });
    const existing = await db.query("SELECT id FROM premium_requests WHERE user_id=$1 AND status='pending'", [req.session.user.id]);
    if (existing.rows[0]) return res.json({ requested: true, status: 'pending' });
    const qualifiesByReferral = Number(user.referral_count || 0) >= 10;
    const status = qualifiesByReferral ? 'approved' : 'pending';
    await db.query('INSERT INTO premium_requests (id,user_id,reason,status,reviewed_by,reviewed_at) VALUES ($1,$2,$3,$4,$5,CASE WHEN $4=$6 THEN NOW() ELSE NULL END)', [nanoid(), req.session.user.id, parsed.data.reason, status, qualifiesByReferral ? 'system-referrals' : null, 'approved']);
    if (qualifiesByReferral) {
      await db.query("UPDATE users SET subscription_tier='premium',green_tick=TRUE,premium_source='referrals',premium_activated_at=COALESCE(premium_activated_at,NOW()) WHERE id=$1", [req.session.user.id]);
      req.session.user.subscriptionTier = 'premium';
      req.session.user.greenTick = true;
      await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [nanoid(), req.session.user.id, 'premium', 'Your 10 verified referrals qualified you for Premium. Your verified blue tick is now active.']);
    }
    res.status(201).json({ requested: true, status, tier: qualifiesByReferral ? 'premium' : 'standard' });
  } catch (error) { next(error); }
});

router.get('/api/admin/premium-requests', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT r.id,r.user_id AS "userId",r.reason,r.status,r.created_at AS "createdAt",u.name AS "userName",u.email AS "userEmail"
      FROM premium_requests r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC`);
    res.json({ requests: result.rows });
  } catch (error) { next(error); }
});

router.post('/api/admin/premium-requests/:id/review', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose approve or reject.' });
    const request = await db.query('SELECT user_id AS "userId" FROM premium_requests WHERE id=$1 AND status=$2', [req.params.id, 'pending']);
    if (!request.rows[0]) return res.status(404).json({ error: 'Pending Premium request not found.' });
    const approved = parsed.data.decision === 'approved';
    await db.query('UPDATE premium_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3', [parsed.data.decision, req.session.user.id, req.params.id]);
    await db.query('UPDATE users SET subscription_tier=$1,green_tick=$2,premium_source=$3,premium_activated_at=CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id=$4', [approved ? 'premium' : 'standard', approved, approved ? 'admin' : null, request.rows[0].userId]);
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [nanoid(), request.rows[0].userId, 'premium', approved ? 'Your Premium request was approved. Your verified blue tick is now active.' : 'Your Premium request was not approved at this time.']);
    res.json({ reviewed: true, approved });
  } catch (error) { next(error); }
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

export default router;
