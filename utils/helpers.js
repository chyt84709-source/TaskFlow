import crypto from 'node:crypto';
import { db } from '../config/database.js';

export function hash(value) {
  return crypto.createHash('sha256').update(`${value}:${process.env.SESSION_SECRET || 'development-only'}`).digest('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return false;
  const [salt, hashValue] = storedValue.split(':');
  if (!salt || !hashValue) return false;
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hashValue, 'hex'), Buffer.from(derived, 'hex'));
}

export function now() {
  return new Date().toISOString();
}

export function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

export async function ensureWalletReady(userId, amountCents) {
  const result = await db.query("SELECT COALESCE(SUM(CASE WHEN kind IN ('payout', 'product_purchase', 'gig_purchase', 'task_purchase', 'marketplace_purchase', 'premium_upgrade') THEN -amount_cents ELSE amount_cents END), 0)::int AS balance FROM transactions WHERE user_id = $1 AND status IN ('paid', 'completed', 'approved', 'success')", [userId]);
  if (Number(result.rows[0]?.balance || 0) < amountCents) throw new Error('Insufficient wallet balance. Add funds in the Wallet section before purchasing.');
}

export async function updateTrustScoreOnSuccessfulTransaction(userId) {
  const result = await db.query('SELECT trust_score FROM users WHERE id = $1', [userId]);
  if (!result.rows[0]) return;
  await db.query('UPDATE users SET trust_score = COALESCE(trust_score, 100) WHERE id = $1', [userId]);
  await db.query(`UPDATE users AS referrer SET referral_count = referrer.referral_count + 1
    FROM referrals
    WHERE referrals.referred_user_id = $1
      AND referrals.referrer_id = referrer.id
      AND referrals.status = 'pending'`, [userId]);
  await db.query("UPDATE referrals SET status = 'verified', verified_at = NOW() WHERE referred_user_id = $1 AND status = 'pending'", [userId]);
}
