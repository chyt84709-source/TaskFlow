import express from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, hash, issueOtp, reqOtp } from '../../config/database.js';
import { requireUser } from '../../utils/helpers.js';

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

export default router;
