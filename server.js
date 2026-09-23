import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import session from 'cookie-session';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import Stripe from 'stripe';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import commerceRoutes from './routes/commerceRoutes.js';
import { deleteEncryptedMedia, processAndEncryptImage, saveEncryptedImage } from './services/media.js';
import { calculateInternationalTax } from './config/database.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const PLATFORM_FEE_RATE = 0.05;
fs.mkdirSync(uploadDir, { recursive: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const googleClient = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL) : null;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const resendFromName = process.env.RESEND_FROM_NAME || 'TaskFlow';
const emailEnabled = Boolean(resendApiKey && resendFromEmail);
const app = express();
const server = http.createServer(app);
const sockets = new Map();
const adminUsername = process.env.SUPER_ADMIN_USERNAME;
const adminPassword = process.env.SUPER_ADMIN_PASSWORD;
const stripeGateway = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!process.env.SESSION_SECRET || !adminUsername || !adminPassword) throw new Error('SESSION_SECRET, SUPER_ADMIN_USERNAME, and SUPER_ADMIN_PASSWORD are required.');
if (process.env.NODE_ENV === 'production' && !emailEnabled) throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL are required in production.');

function hash(value) { return crypto.createHash('sha256').update(`${value}:${process.env.SESSION_SECRET || 'development-only'}`).digest('hex'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${derived}`;
}
function verifyPassword(password, storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return false;
  const [salt, hashValue] = storedValue.split(':');
  if (!salt || !hashValue) return false;
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hashValue, 'hex'), Buffer.from(derived, 'hex'));
}
function now() { return new Date().toISOString(); }
const COUNTRY_CURRENCY = {
  US: { code: 'USD', symbol: '$', rate: 1 },
  PK: { code: 'PKR', symbol: '₨', rate: 278 },
  IN: { code: 'INR', symbol: '₹', rate: 83 },
  AE: { code: 'AED', symbol: 'د.إ', rate: 3.67 },
  GB: { code: 'GBP', symbol: '£', rate: 0.79 },
  CA: { code: 'CAD', symbol: 'C$', rate: 1.36 },
  SA: { code: 'SAR', symbol: '﷼', rate: 3.75 },
  BD: { code: 'BDT', symbol: '৳', rate: 108 },
  NG: { code: 'NGN', symbol: '₦', rate: 1500 }
};
function normalizeCountry(country) {
  const code = String(country || 'US').trim().toUpperCase();
  return COUNTRY_CURRENCY[code] ? code : 'US';
}
function getCurrencyMeta(country) {
  return COUNTRY_CURRENCY[normalizeCountry(country)] || COUNTRY_CURRENCY.US;
}
async function updateTrustScoreOnSuccessfulTransaction(userId) {
  if (!userId) return;
  const successCheck = await db.query("SELECT 1 FROM transactions WHERE user_id = $1 AND status IN ('paid', 'completed', 'approved', 'success') LIMIT 1", [userId]);
  if (!successCheck.rows.length) return;
  const result = await db.query('SELECT trust_score FROM users WHERE id = $1', [userId]);
  const currentScore = result.rows[0]?.trust_score;
  if (currentScore === null || currentScore === undefined) {
    await db.query('UPDATE users SET trust_score = 100 WHERE id = $1', [userId]);
  } else {
    await db.query('UPDATE users SET trust_score = GREATEST(COALESCE(trust_score, 0), 100) WHERE id = $1', [userId]);
  }
  await db.query(`UPDATE users AS referrer SET referral_count = referrer.referral_count + 1
    FROM referrals
    WHERE referrals.referred_user_id = $1
      AND referrals.referrer_id = referrer.id
      AND referrals.status = 'pending'`, [userId]);
  await db.query("UPDATE referrals SET status = 'verified', verified_at = NOW() WHERE referred_user_id = $1 AND status = 'pending'", [userId]);
  await db.query(`UPDATE users
    SET subscription_tier = 'premium',
        premium_source = 'referrals',
        premium_activated_at = COALESCE(premium_activated_at, NOW()),
        green_tick = TRUE
    WHERE referral_count >= 10`);
}
async function initializeSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, name TEXT, role TEXT NOT NULL DEFAULT 'worker', country TEXT, subscription_tier TEXT NOT NULL DEFAULT 'standard', trust_score DOUBLE PRECISION DEFAULT NULL, two_factor BOOLEAN NOT NULL DEFAULT FALSE, password_hash TEXT, referral_count INTEGER NOT NULL DEFAULT 0, referral_code TEXT UNIQUE, green_tick BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL, referred_user_id TEXT UNIQUE NOT NULL, referral_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS media_files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, purpose TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, client_id TEXT, title TEXT NOT NULL, video_url TEXT NOT NULL, seconds INTEGER NOT NULL, payout_cents INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, seller_id TEXT, title TEXT NOT NULL, type TEXT NOT NULL, price_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, metadata JSONB, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS disputes (id TEXT PRIMARY KEY, opened_by TEXT, order_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT, attachment TEXT, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, media JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, user_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS cart_items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, product_id));
    CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, location TEXT NOT NULL, media JSONB NOT NULL DEFAULT '[]'::jsonb, destination_url TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS ad_messages (id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS gigs (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, delivery_days INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, gig_id TEXT NOT NULL, buyer_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, bio TEXT, location TEXT, avatar_url TEXT, skills TEXT, social_links JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS favorites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, target_type, target_id));
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS content_offers (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, content_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', conversation_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), responded_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, content_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, offer_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS service_orders (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, package_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', delivery_text TEXT, revisions INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_applications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_submissions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, proof_url TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'submitted', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS wallet_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, holder_name TEXT NOT NULL, card_brand TEXT NOT NULL, last4 TEXT NOT NULL, expiry TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS wallet_card_verifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, holder_name TEXT NOT NULL, card_type TEXT NOT NULL, card_brand TEXT NOT NULL, last4 TEXT NOT NULL, expiry TEXT NOT NULL, setup_intent_id TEXT, otp_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_orders (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', target_url TEXT, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS product_orders (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS gig_orders (id TEXT PRIMARY KEY, gig_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, package_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_product_idx ON reviews (product_id, user_id);`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'standard'; ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score DOUBLE PRECISION; ALTER TABLE users ALTER COLUMN trust_score DROP NOT NULL; ALTER TABLE users ALTER COLUMN trust_score SET DEFAULT NULL; ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE; ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_source TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_activated_at TIMESTAMPTZ; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_by TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_url TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS qualification TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS description TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS category TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS location TEXT; ALTER TABLE ads ADD COLUMN IF NOT EXISTS placement TEXT DEFAULT 'homepage-top'; ALTER TABLE ads ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 7; ALTER TABLE ads ADD COLUMN IF NOT EXISTS skip_allowed BOOLEAN DEFAULT TRUE; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS portfolio TEXT; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS seller_level TEXT; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS basic_price_cents INTEGER; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS standard_price_cents INTEGER; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS premium_price_cents INTEGER;`);
  await db.query("ALTER TABLE wallet_cards ADD COLUMN IF NOT EXISTS card_type TEXT NOT NULL DEFAULT 'credit';");
  await db.query("ALTER TABLE ads ADD COLUMN IF NOT EXISTS destination_url TEXT;");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS green_tick BOOLEAN NOT NULL DEFAULT FALSE;");
  await db.query("UPDATE users SET subscription_tier = 'premium', premium_source = 'referrals', premium_activated_at = COALESCE(premium_activated_at, NOW()), green_tick = TRUE WHERE referral_count >= 10;");
  await db.query("ALTER TABLE wallet_card_verifications ADD COLUMN IF NOT EXISTS setup_intent_id TEXT;");
  await db.query("DELETE FROM transactions WHERE kind = 'deposit';");
  await db.query("ALTER TABLE content_offers ADD COLUMN IF NOT EXISTS conversation_id TEXT;");
  await db.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';");
}

async function seedDemoData() {
  // Production starts with empty marketplace and wallet state.
}

async function sendOtpEmail({ to, code, subject = 'Your TaskFlow verification code', html = `<p>Your TaskFlow verification code is <strong>${code}</strong>.</p><p>This code expires in five minutes.</p>` }) {
  if (!emailEnabled || !to) return;

  const payload = {
    from: `${resendFromName} <${resendFromEmail}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend email request failed (${response.status}): ${text}`);
  }
}

async function sendPasswordResetEmail({ to, code }) {
  await sendOtpEmail({
    to,
    code,
    subject: 'Reset your TaskFlow password',
    html: `<p>Use the code <strong>${code}</strong> to reset your TaskFlow password.</p><p>This code expires in five minutes.</p><p>If you did not request this, you can ignore this email.</p>`,
  });
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000', credentials: true }));
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeGateway || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook is not configured');
  let event;
  try {
    event = stripeGateway.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const checkoutSession = event.data.object;
      const userId = checkoutSession.metadata?.userId || checkoutSession.client_reference_id;
      const duplicate = await db.query("SELECT id FROM transactions WHERE kind='premium_upgrade' AND metadata->>'stripeSessionId'=$1", [checkoutSession.id]);
      if (!duplicate.rows.length && userId) {
        const chargedCents = Number(checkoutSession.amount_total || 500);
        await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), userId, 'premium_upgrade', chargedCents, 'paid', { stripeSessionId: checkoutSession.id, provider: 'stripe', taxCents: Number(checkoutSession.metadata?.taxCents || 0), country: checkoutSession.metadata?.country || 'US' }, now()]);
        await db.query('UPDATE users SET subscription_tier=$1, premium_source=$2, premium_activated_at=$3 WHERE id=$4', ['premium', 'stripe', now(), userId]);
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error);
    res.status(500).send('Webhook processing failed');
  }
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({ name: 'taskflow.sid', keys: [process.env.SESSION_SECRET || 'local-development-secret'], httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use(authRoutes);
app.use(userRoutes);
app.use(commerceRoutes);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(jpeg|png|webp|gif|avif|heic)$/.test(file.mimetype) || /^video\/(mp4|webm|quicktime|x-msvideo|x-matroska)$/.test(file.mimetype);
    cb(null, allowed);
  }
});

function requireUser(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Authentication required' }); next(); }
function requireAdmin(req, res, next) {
  const isAdmin = Boolean(req.session.user?.isAdmin || req.session.user?.role === 'admin');
  if (!isAdmin) return res.status(403).json({ error: 'Super-admin access required' });
  if (req.session.user) req.session.user.isAdmin = true;
  next();
}

function hydrateSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email || null,
    role: String(user.role || 'worker'),
    country: normalizeCountry(user.country || 'US'),
    subscriptionTier: user.subscription_tier || user.subscriptionTier || 'standard',
    trustScore: user.trust_score ?? user.trustScore ?? null,
    twoFactor: Boolean(user.two_factor ?? user.twoFactor),
    isAdmin: Boolean(user.role === 'admin' || user.isAdmin || false)
  };
}

function isValidDestinationUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/.test(trimmed);
  }
}

async function ensureWalletReady(userId, amountCents) {
  const [cardResult, balanceResult] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS count FROM wallet_cards WHERE user_id = $1', [userId]),
    db.query("SELECT COALESCE(SUM(CASE WHEN kind IN ('payout', 'product_purchase', 'gig_purchase', 'task_purchase', 'marketplace_purchase', 'premium_upgrade') THEN -amount_cents ELSE amount_cents END), 0)::int AS balance FROM transactions WHERE user_id = $1 AND status IN ('paid', 'completed', 'approved', 'success')", [userId])
  ]);
  const hasCard = Number(cardResult.rows[0]?.count || 0) > 0;
  const balanceCents = Number(balanceResult.rows[0]?.balance || 0);
  if (!hasCard) throw new Error('Add a payment method in the Wallet section before making a purchase.');
  if (balanceCents < amountCents) throw new Error('Insufficient wallet balance. Add funds in the Wallet section before purchasing.');
}
async function audit(kind, userId, amountCents = 0, metadata = {}) { await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), userId, kind, amountCents, 'recorded', metadata, now()]); }
function issueOtp(identifier) { const code = String(crypto.randomInt(100000, 1000000)); const digest = hash(code); if (!reqOtp.has(identifier)) reqOtp.set(identifier, new Map()); reqOtp.get(identifier).set(digest, Date.now() + 5 * 60 * 1000); return code; }
const reqOtp = new Map();

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'taskflow', time: now() }));
app.post('/api/uploads', requireUser, upload.array('files', 10), async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    const savedFiles = [];
    for (const file of files) {
      const image = await processAndEncryptImage(file.buffer, file.mimetype || 'application/octet-stream');
      const id = nanoid();
      const filename = await saveEncryptedImage(image.payload, id);
      await db.query('INSERT INTO media_files (id,user_id,filename,mime_type,purpose) VALUES ($1,$2,$3,$4,$5)', [id, req.session.user.id, filename, image.mimeType, 'marketplace-media']);
      savedFiles.push({ name: file.originalname, url: `/api/media/${id}`, size: file.size, mimeType: image.mimeType });
    }
    res.status(201).json({ files: savedFiles });
  } catch (error) {
    next(error);
  }
});
app.get('/api/summary', async (_req, res, next) => { try { const [users, tasks, listings, paid] = await Promise.all([db.query('SELECT COUNT(*)::int AS count FROM users'), db.query("SELECT COUNT(*)::int AS count FROM tasks WHERE status='active'"), db.query("SELECT COUNT(*)::int AS count FROM listings WHERE status='active'"), db.query("SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM transactions WHERE amount_cents > 0")]); res.json({ users: users.rows[0].count, activeTasks: tasks.rows[0].count, activeListings: listings.rows[0].count, paidCents: paid.rows[0].total }); } catch (error) { next(error); } });
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  req.session.user = { ...req.session.user, ...hydrateSessionUser(req.session.user) };
  res.json({ user: req.session.user });
});
app.get('/api/currency', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT country, subscription_tier FROM users WHERE id = $1', [req.session.user.id]); const country = normalizeCountry(result.rows[0]?.country || req.session.user.country || 'US'); const meta = getCurrencyMeta(country); res.json({ country, code: meta.code, symbol: meta.symbol, rate: meta.rate }); } catch (error) { next(error); } });
app.post('/api/auth/signup', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), password: z.string().min(6).max(128), name: z.string().min(1).max(100), role: z.enum(['worker', 'client']).default('worker'), subscriptionTier: z.enum(['standard', 'premium']).default('standard'), country: z.string().max(80).default('US') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid name, email, password, and role are required' }); const email = parsed.data.email.toLowerCase(); const existing = await db.query('SELECT * FROM users WHERE email=$1', [email]); if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' }); const passwordHash = hashPassword(parsed.data.password); const user = { id: nanoid(), email, name: parsed.data.name.trim(), role: parsed.data.role, country: normalizeCountry(parsed.data.country), subscription_tier: parsed.data.subscriptionTier, trust_score: null, two_factor: false, password_hash: passwordHash, created_at: now() }; await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.password_hash, user.created_at]); req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: user.country, subscriptionTier: user.subscription_tier, trustScore: user.trust_score, twoFactor: false, isAdmin: false }; res.status(201).json({ user: req.session.user }); } catch (error) { next(error); } });
app.post('/api/auth/login', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), password: z.string().min(6).max(128) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Email and password are required' }); const email = parsed.data.email.toLowerCase(); const userResult = await db.query('SELECT * FROM users WHERE email=$1', [email]); const user = userResult.rows[0]; if (!user || !user.password_hash || !verifyPassword(parsed.data.password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' }); req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: user.role === 'admin' }; res.json({ user: req.session.user }); } catch (error) { next(error); } });
app.post('/api/auth/forgot-password', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid email address required' }); const email = parsed.data.email.toLowerCase(); const userResult = await db.query('SELECT id, name, email FROM users WHERE email=$1', [email]); if (!userResult.rows[0]) return res.json({ ok: true, message: 'If an account exists for that email, a password reset code has been sent.' }); if (!emailEnabled) return res.status(503).json({ error: 'Password reset email delivery is not configured on this deployment.' }); const code = issueOtp(email); try { await sendPasswordResetEmail({ to: email, code }); } catch (error) { console.error('Password reset email delivery failed:', error.message || error); return res.status(502).json({ error: 'Unable to deliver password reset email. Please try again shortly.' }); } res.json({ ok: true, message: 'A password reset code has been sent to your email.' }); } catch (error) { next(error); } });
app.post('/api/auth/reset-password', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/), password: z.string().min(6).max(128) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Email, reset code, and a new password are required' }); const email = parsed.data.email.toLowerCase(); const records = reqOtp.get(email); const digest = hash(parsed.data.code); if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired reset code' }); records.delete(digest); const passwordHash = hashPassword(parsed.data.password); await db.query('UPDATE users SET password_hash=$1 WHERE email=$2', [passwordHash, email]); res.json({ ok: true, message: 'Password updated successfully. You can sign in with your new password.' }); } catch (error) { next(error); } });
app.post('/api/auth/email/request', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid email address required' }); if (!emailEnabled) return res.status(503).json({ error: 'Email verification is not configured on this deployment.' }); const code = issueOtp(parsed.data.email.toLowerCase()); try { await sendOtpEmail({ to: parsed.data.email, code }); } catch (error) { console.error('Sign-in email delivery failed:', error.message || error); return res.status(502).json({ error: 'Unable to deliver verification email. Please try again shortly.' }); } res.json({ ok: true, expiresIn: 300 }); } catch (error) { next(error); } });
app.post('/api/auth/email/verify', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(100).optional(), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' }); const email = parsed.data.email.toLowerCase(); const records = reqOtp.get(email); const digest = hash(parsed.data.code); if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' }); records.delete(digest); const result = await db.query('SELECT * FROM users WHERE email=$1', [email]); let user = result.rows[0]; if (!user) { user = { id: nanoid(), email, name: parsed.data.name || email.split('@')[0], role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, created_at: now() }; await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.created_at]); } req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.json({ user: req.session.user }); } catch (error) { next(error); } });
app.post('/api/auth/register', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), name: z.string().min(1).max(100), password: z.string().min(6).max(128).optional(), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid name, email, and password are required' }); const email = parsed.data.email.toLowerCase(); const existing = await db.query('SELECT * FROM users WHERE email=$1', [email]); if (existing.rows[0]) return res.status(409).json({ error: 'This email is already registered. Please sign in.' }); const passwordHash = parsed.data.password ? hashPassword(parsed.data.password) : hashPassword('temporary-password'); const user = { id: nanoid(), email, name: parsed.data.name.trim(), role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, password_hash: passwordHash, created_at: now() }; await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.password_hash, user.created_at]); req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: false, isAdmin: false }; res.status(201).json({ user: req.session.user }); } catch (error) { next(error); } });
app.post('/api/premium/upgrade', requireUser, async (req, res, next) => { try { const parsed = z.object({ tier: z.enum(['standard', 'premium']).default('premium') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid premium tier request' }); await db.query('UPDATE users SET subscription_tier = $1 WHERE id = $2', [parsed.data.tier, req.session.user.id]); req.session.user.subscriptionTier = parsed.data.tier; res.json({ ok: true, tier: parsed.data.tier }); } catch (error) { next(error); } });
app.get('/api/profile', requireUser, async (req, res, next) => { try {
  const [userResult, profileResult] = await Promise.all([
    db.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]),
    db.query('SELECT * FROM profiles WHERE user_id=$1', [req.session.user.id])
  ]);
  const user = userResult.rows[0];
  const profile = profileResult.rows[0] || null;
  if (!user) return res.json({ user: null });
  const normalizedUser = hydrateSessionUser({ ...user, country: normalizeCountry(user.country || 'US') });
  req.session.user = { ...req.session.user, ...normalizedUser };
  res.json({
    user: {
      ...user,
      country: normalizeCountry(user.country || 'US'),
      isAdmin: normalizedUser.isAdmin,
      role: normalizedUser.role,
      subscriptionTier: normalizedUser.subscriptionTier,
      profile
    }
  });
} catch (error) { next(error); } });
app.put('/api/profile', requireUser, async (req, res, next) => { try { const parsed = z.object({ name: z.string().min(1).max(100).optional(), bio: z.string().max(500).optional(), location: z.string().max(120).optional(), country: z.string().max(80).optional(), avatarUrl: z.string().url().max(500).optional(), skills: z.string().max(500).optional(), phone: z.string().max(20).optional(), subscriptionTier: z.enum(['standard', 'premium']).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid profile update' }); const values = parsed.data; if (values.name) await db.query('UPDATE users SET name=$1 WHERE id=$2', [values.name, req.session.user.id]); if (values.phone) await db.query('UPDATE users SET phone=$1 WHERE id=$2', [values.phone, req.session.user.id]); if (values.country) await db.query('UPDATE users SET country=$1 WHERE id=$2', [normalizeCountry(values.country), req.session.user.id]); if (values.subscriptionTier) await db.query('UPDATE users SET subscription_tier=$1 WHERE id=$2', [values.subscriptionTier, req.session.user.id]); if (values.avatarUrl) await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [values.avatarUrl, req.session.user.id]); await db.query(`INSERT INTO profiles (id, user_id, bio, location, avatar_url, skills, social_links, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, location = EXCLUDED.location, avatar_url = EXCLUDED.avatar_url, skills = EXCLUDED.skills`, [nanoid(), req.session.user.id, values.bio || null, values.location || null, values.avatarUrl || null, values.skills || null, JSON.stringify({}), now()]); req.session.user.name = values.name || req.session.user.name; req.session.user.country = normalizeCountry(values.country || req.session.user.country || 'US'); req.session.user.subscriptionTier = values.subscriptionTier || req.session.user.subscriptionTier || 'standard'; res.json({ ok: true }); } catch (error) { next(error); } });
app.get('/api/search', async (req, res, next) => { try { const q = String(req.query.q || '').trim(); if (!q) return res.json({ products: [], listings: [], gigs: [], tasks: [] }); const productQuery = await db.query('SELECT * FROM products WHERE LOWER(title) LIKE LOWER($1) OR LOWER(description) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]); const listingQuery = await db.query('SELECT * FROM listings WHERE LOWER(title) LIKE LOWER($1) OR LOWER(type) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]); const gigQuery = await db.query('SELECT * FROM gigs WHERE LOWER(title) LIKE LOWER($1) OR LOWER(description) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]); const taskQuery = await db.query('SELECT * FROM tasks WHERE LOWER(title) LIKE LOWER($1) OR LOWER(video_url) LIKE LOWER($1) ORDER BY created_at DESC LIMIT 20', [`%${q}%`]); res.json({ products: productQuery.rows, listings: listingQuery.rows, gigs: gigQuery.rows, tasks: taskQuery.rows }); } catch (error) { next(error); } });
app.get('/api/favorites', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM favorites WHERE user_id=$1 ORDER BY created_at DESC', [req.session.user.id]); res.json({ favorites: result.rows }); } catch (error) { next(error); } });
app.post('/api/favorites', requireUser, async (req, res, next) => { try { const parsed = z.object({ targetType: z.enum(['product','listing','gig']), targetId: z.string().min(1) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid favorite payload' }); await db.query('INSERT INTO favorites (id,user_id,target_type,target_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, target_type, target_id) DO NOTHING', [nanoid(), req.session.user.id, parsed.data.targetType, parsed.data.targetId, now()]); res.status(201).json({ ok: true }); } catch (error) { next(error); } });
app.get('/api/offers', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM offers WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC', [req.session.user.id]); res.json({ offers: result.rows }); } catch (error) { next(error); } });
app.post('/api/offers', requireUser, async (req, res, next) => { try { const parsed = z.object({ listingId: z.string().min(1), sellerId: z.string().min(1), amountCents: z.number().int().positive(), message: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid offer payload' }); const offer = { id: nanoid(), listingId: parsed.data.listingId, buyerId: req.session.user.id, sellerId: parsed.data.sellerId, amountCents: parsed.data.amountCents, message: parsed.data.message || null, createdAt: now() }; await db.query('INSERT INTO offers (id,listing_id,buyer_id,seller_id,amount_cents,message,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [offer.id, offer.listingId, offer.buyerId, offer.sellerId, offer.amountCents, offer.message, 'pending', offer.createdAt]); res.status(201).json({ offer }); } catch (error) { next(error); } });
app.get('/api/products', async (req, res, next) => { try { const search = String(req.query.search || '').trim(); const category = String(req.query.category || '').trim(); let query = `SELECT p.*, COALESCE(AVG(r.rating), 0)::float AS avg_rating, COUNT(r.id)::int AS review_count FROM products p LEFT JOIN reviews r ON r.product_id = p.id`; const params = []; if (search) { params.push(`%${search}%`); query += ` WHERE LOWER(p.title) LIKE LOWER($${params.length}) OR LOWER(p.description) LIKE LOWER($${params.length})`; } if (category) { params.push(category); query += params.length === 1 ? ' WHERE' : ' AND'; query += ` p.category = $${params.length}`; } query += ' GROUP BY p.id ORDER BY p.created_at DESC'; const result = await db.query(query, params); res.json({ products: result.rows }); } catch (error) { next(error); } });
app.post('/api/products', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), stock: z.number().int().min(0).default(1), media: z.array(z.string().min(1)).default([]) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload' }); const priceCents = Number(parsed.data.priceCents ?? Math.round((parsed.data.priceDollars || 0) * 100)); const product = { id: nanoid(), vendorId: req.session.user.id, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, priceCents, stock: parsed.data.stock, media: parsed.data.media, createdAt: now() }; await db.query('INSERT INTO products (id,vendor_id,title,description,category,price_cents,stock,media,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [product.id, product.vendorId, product.title, product.description, product.category, product.priceCents, product.stock, JSON.stringify(product.media), product.createdAt]); res.status(201).json({ product }); } catch (error) { next(error); } });
app.post('/api/products/:id/purchase', requireUser, async (req, res, next) => { try { const parsed = z.object({ quantity: z.number().int().min(1).max(50).default(1), notes: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid purchase details are required' }); const product = await db.query('SELECT * FROM products WHERE id=$1', [req.params.id]); if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' }); const quantity = parsed.data.quantity; const amountCents = Number(product.rows[0].price_cents) * quantity; await ensureWalletReady(req.session.user.id, amountCents); const feeCents = Math.round(amountCents * 0.01); const order = { id: nanoid(), productId: req.params.id, buyerId: req.session.user.id, sellerId: product.rows[0].vendor_id, quantity, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: now() }; await db.query('INSERT INTO product_orders (id,product_id,buyer_id,seller_id,quantity,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.productId, order.buyerId, order.sellerId, order.quantity, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]); await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'product_purchase', order.amountCents, 'paid', { productId: order.productId, quantity, feeCents: order.feeCents }, now()]); await updateTrustScoreOnSuccessfulTransaction(order.buyerId); res.status(201).json({ order, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents }); } catch (error) { next(error); } });
app.post('/api/products/:id/reviews', requireUser, async (req, res, next) => { try { const parsed = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid review required' }); const review = { id: nanoid(), productId: req.params.id, userId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO reviews (id,product_id,user_id,rating,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (product_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment', [review.id, review.productId, review.userId, review.rating, review.comment || null, review.createdAt]); res.status(201).json({ review }); } catch (error) { next(error); } });
app.get('/api/cart', requireUser, async (_req, res, next) => { try { const result = await db.query(`SELECT ci.id, ci.product_id AS "productId", ci.quantity, p.title, p.price_cents AS "priceCents", p.category, p.media FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = $1 ORDER BY ci.created_at DESC`, [_req.session.user.id]); res.json({ items: result.rows }); } catch (error) { next(error); } });
app.post('/api/cart', requireUser, async (req, res, next) => { try { const parsed = z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(20).default(1) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid cart item' }); await db.query('INSERT INTO cart_items (id,user_id,product_id,quantity,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity', [nanoid(), req.session.user.id, parsed.data.productId, parsed.data.quantity, now()]); res.status(201).json({ ok: true, quantity: parsed.data.quantity }); } catch (error) { next(error); } });
app.delete('/api/cart/:productId', requireUser, async (req, res, next) => { try { const result = await db.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.session.user.id, req.params.productId]); if (!result.rowCount) return res.status(404).json({ error: 'Cart item not found' }); res.status(204).end(); } catch (error) { next(error); } });
app.post('/api/checkout/cart', requireUser, async (req, res, next) => { try { const result = await db.query(`SELECT ci.quantity, p.price_cents AS "priceCents" FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = $1`, [req.session.user.id]); const subtotalCents = result.rows.reduce((sum, row) => sum + row.quantity * row.priceCents, 0); const feeCents = Math.round(subtotalCents * PLATFORM_FEE_RATE); const totalCents = subtotalCents + feeCents; await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), req.session.user.id, 'marketplace_purchase', totalCents, 'paid', { feeCents, subtotalCents, source: 'cart' }, now()]); await updateTrustScoreOnSuccessfulTransaction(req.session.user.id); await db.query('DELETE FROM cart_items WHERE user_id=$1', [req.session.user.id]); res.json({ subtotalCents, feeCents, totalCents, platformFeePercent: PLATFORM_FEE_RATE * 100 }); } catch (error) { next(error); } });
app.get('/api/ads', async (_req, res, next) => { try { const result = await db.query("SELECT * FROM ads WHERE status = 'active' AND created_at + (COALESCE(duration_days, 7) * INTERVAL '1 day') >= NOW() ORDER BY created_at DESC"); res.json({ ads: result.rows }); } catch (error) { next(error); } });
app.post('/api/ads', requireAdmin, async (req, res, next) => { try {
  const parsed = z.object({
    title: z.string().min(3).max(120),
    description: z.string().min(5).max(2000),
    category: z.string().min(2).max(60),
    location: z.string().min(2).max(120),
    priceCents: z.number().int().positive(),
    placement: z.string().min(2).max(80).default('homepage-top'),
    durationDays: z.number().int().min(1).max(365).default(7),
    skipAllowed: z.boolean().default(true),
    media: z.array(z.string().min(1)).default([]),
    destinationUrl: z.string().trim().max(500).refine(isValidDestinationUrl, { message: 'Valid destination link required' }).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ad payload' });
  const destinationUrl = parsed.data.destinationUrl || null;
  const ad = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, media: parsed.data.media, destinationUrl, createdAt: now() };
  await db.query('INSERT INTO ads (id,seller_id,title,description,category,price_cents,location,media,status,placement,duration_days,skip_allowed,destination_url,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [ad.id, ad.sellerId, ad.title, ad.description, ad.category, ad.priceCents, ad.location, JSON.stringify(ad.media), 'active', ad.placement, ad.durationDays, ad.skipAllowed, ad.destinationUrl, ad.createdAt]);
  res.status(201).json({ ad });
} catch (error) { next(error); } });
app.delete('/api/ads/:id', requireAdmin, async (req, res, next) => { try { const result = await db.query('DELETE FROM ads WHERE id = $1', [req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Ad not found' }); res.status(204).end(); } catch (error) { next(error); } });
app.get('/api/ads/:id/messages', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM ad_messages WHERE ad_id=$1 ORDER BY created_at ASC', [req.params.id]); res.json({ messages: result.rows }); } catch (error) { next(error); } });
app.post('/api/ads/:id/messages', requireUser, async (req, res, next) => { try { const parsed = z.object({ body: z.string().min(1).max(1000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Message required' }); const message = { id: nanoid(), adId: req.params.id, senderId: req.session.user.id, body: parsed.data.body, createdAt: now() }; await db.query('INSERT INTO ad_messages (id,ad_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, message.adId, message.senderId, message.body, message.createdAt]); res.status(201).json({ message }); } catch (error) { next(error); } });
app.get('/api/gigs', async (_req, res, next) => { try { const result = await db.query('SELECT * FROM gigs ORDER BY created_at DESC'); res.json({ gigs: result.rows }); } catch (error) { next(error); } });
app.post('/api/gigs', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(10).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), deliveryDays: z.number().int().min(1).max(30).default(3), portfolioMedia: z.array(z.string().min(1)).default([]) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid gig payload' }); const priceCents = Number(parsed.data.priceCents ?? Math.round((parsed.data.priceDollars || 0) * 100)); const gig = { id: nanoid(), sellerId: req.session.user.id, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, priceCents, deliveryDays: parsed.data.deliveryDays, portfolioMedia: parsed.data.portfolioMedia, createdAt: now() }; await db.query('INSERT INTO gigs (id,seller_id,title,description,category,price_cents,delivery_days,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [gig.id, gig.sellerId, gig.title, gig.description, gig.category, gig.priceCents, gig.deliveryDays, 'active', gig.createdAt]); res.status(201).json({ gig }); } catch (error) { next(error); } });
app.post('/api/gigs/:id/purchase', requireUser, async (req, res, next) => { try { const parsed = z.object({ packageName: z.string().min(2).max(80).default('Standard'), notes: z.string().max(1000).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid gig purchase details are required' }); const gig = await db.query('SELECT * FROM gigs WHERE id=$1 AND status=$2', [req.params.id, 'active']); if (!gig.rows[0]) return res.status(404).json({ error: 'Gig not found' }); const amountCents = Number(gig.rows[0].price_cents); await ensureWalletReady(req.session.user.id, amountCents); const feeCents = Math.round(amountCents * 0.05); const order = { id: nanoid(), gigId: req.params.id, buyerId: req.session.user.id, sellerId: gig.rows[0].seller_id, packageName: parsed.data.packageName, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: now() }; await db.query('INSERT INTO gig_orders (id,gig_id,buyer_id,seller_id,package_name,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.gigId, order.buyerId, order.sellerId, order.packageName, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]); await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'gig_purchase', order.amountCents, 'paid', { gigId: order.gigId, packageName: order.packageName, feeCents: order.feeCents }, now()]); await updateTrustScoreOnSuccessfulTransaction(order.buyerId); res.status(201).json({ order, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents }); } catch (error) { next(error); } });
app.post('/api/gigs/:id/proposals', requireUser, async (req, res, next) => { try { const parsed = z.object({ amountCents: z.number().int().positive(), note: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid bid proposal' }); const proposal = { id: nanoid(), gigId: req.params.id, buyerId: req.session.user.id, amountCents: parsed.data.amountCents, note: parsed.data.note || null, createdAt: now() }; await db.query('INSERT INTO proposals (id,gig_id,buyer_id,amount_cents,note,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [proposal.id, proposal.gigId, proposal.buyerId, proposal.amountCents, proposal.note, 'pending', proposal.createdAt]); res.status(201).json({ proposal }); } catch (error) { next(error); } });
app.post('/api/auth/phone/request', (_req, res) => res.status(503).json({ error: 'Phone verification is not configured. Use email verification or configure a phone provider.' }));
app.post('/api/auth/phone/verify', async (req, res, next) => { try { const parsed = z.object({ phone: z.string().min(7).max(20), code: z.string().regex(/^\d{6}$/), name: z.string().max(100).optional(), role: z.enum(['worker', 'client', 'admin']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' }); const records = reqOtp.get(parsed.data.phone); const digest = hash(parsed.data.code); if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' }); records.delete(digest); const result = await db.query('SELECT * FROM users WHERE phone=$1', [parsed.data.phone]); let user = result.rows[0]; if (!user) { user = { id: nanoid(), phone: parsed.data.phone, name: parsed.data.name || 'TaskFlow member', role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, created_at: now() }; await db.query('INSERT INTO users (id,phone,name,role,country,subscription_tier,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.phone, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.created_at]); } req.session.user = { id: user.id, name: user.name, email: user.email || null, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.json({ user: req.session.user }); } catch (error) { next(error); } });
app.get('/api/auth/google', (req, res) => { if (req.session.user) return res.redirect('/#overview'); if (!googleClient) return res.status(501).json({ error: 'Google OAuth is not configured' }); const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state; res.redirect(googleClient.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' })); });
app.get('/api/auth/google/callback', async (req, res, next) => { try { if (!googleClient || req.query.error) return res.redirect('/?auth=google-failed'); if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).json({ error: 'Invalid OAuth state' }); delete req.session.oauthState; const { tokens } = await googleClient.getToken(String(req.query.code)); const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID }); const profile = ticket.getPayload(); if (!profile?.email) return res.status(400).json({ error: 'Google account has no email' }); const result = await db.query('INSERT INTO users (id,email,name,role,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING *', [nanoid(), profile.email, profile.name || 'TaskFlow member', 'worker', null, false, now()]); const user = result.rows[0]; req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.redirect('/#overview'); } catch (error) { next(error); } });
app.post('/api/auth/logout', (req, res) => { req.session = null; res.status(204).end(); });
app.post('/api/auth/2fa/enable', requireUser, async (req, res, next) => { try { const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Six-digit code required' }); await db.query('UPDATE users SET two_factor=TRUE WHERE id=$1', [req.session.user.id]); req.session.user.twoFactor = true; await audit('2fa_enabled', req.session.user.id, 0); res.json({ enabled: true }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/apply', requireUser, async (req, res, next) => { try { const parsed = z.object({ message: z.string().max(500).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid application' }); const app = { id: nanoid(), taskId: req.params.id, workerId: req.session.user.id, message: parsed.data.message || null, createdAt: now() }; await db.query('INSERT INTO task_applications (id,task_id,worker_id,message,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [app.id, app.taskId, app.workerId, app.message, 'pending', app.createdAt]); res.status(201).json({ application: app }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/submit', requireUser, async (req, res, next) => { try { const parsed = z.object({ proofUrl: z.string().url().optional(), notes: z.string().max(1000).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid submission' }); const submission = { id: nanoid(), taskId: req.params.id, workerId: req.session.user.id, proofUrl: parsed.data.proofUrl || null, notes: parsed.data.notes || null, createdAt: now() }; await db.query('INSERT INTO task_submissions (id,task_id,worker_id,proof_url,notes,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [submission.id, submission.taskId, submission.workerId, submission.proofUrl, submission.notes, 'submitted', submission.createdAt]); res.status(201).json({ submission }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/verify', requireUser, async (req, res, next) => { try { const parsed = z.object({ decision: z.enum(['approve','reject']), amountCents: z.number().int().min(0).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' }); await db.query('UPDATE task_submissions SET status=$1 WHERE task_id=$2 AND worker_id=$3', [parsed.data.decision === 'approve' ? 'approved' : 'rejected', req.params.id, req.session.user.id]); if (parsed.data.decision === 'approve') { const task = await db.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]); const payout = Number(parsed.data.amountCents ?? task.rows[0]?.payout_cents ?? 0); await audit('task_reward', req.session.user.id, payout, { taskId: req.params.id, verified: true }); } res.json({ ok: true, decision: parsed.data.decision }); } catch (error) { next(error); } });
app.post('/api/payments/deposit', requireUser, (_req, res) => res.status(410).json({ error: 'Manual deposits are disabled. Configure a verified Stripe payment flow.' }));
app.post('/api/payments/withdraw', requireUser, async (req, res, next) => { try { const parsed = z.object({ amountCents: z.number().int().positive(), destination: z.string().min(3).max(120) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid withdrawal payload' }); await db.query('INSERT INTO withdrawals (id,user_id,amount_cents,destination,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [nanoid(), req.session.user.id, parsed.data.amountCents, parsed.data.destination, 'pending', now()]); res.status(201).json({ ok: true }); } catch (error) { next(error); } });
app.post('/api/reports', requireUser, async (req, res, next) => { try { const parsed = z.object({ subject: z.string().min(2).max(120), reason: z.string().min(5).max(2000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid report payload' }); const report = { id: nanoid(), userId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO reports (id,user_id,subject,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [report.id, report.userId, report.subject, report.reason, 'open', report.createdAt]); res.status(201).json({ report }); } catch (error) { next(error); } });

app.get('/api/tasks', async (_req, res, next) => { try { const result = await db.query("SELECT id,client_id AS \"clientId\",title,description,video_url AS \"videoUrl\",seconds,payout_cents AS \"payoutCents\",status,created_at AS \"createdAt\" FROM tasks WHERE status='active' ORDER BY created_at DESC"); res.json({ tasks: result.rows }); } catch (error) { next(error); } });
app.post('/api/tasks', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), videoUrl: z.string().url(), description: z.string().max(2000).default(''), amountDollars: z.number().min(1).max(1000000).optional(), payoutCents: z.number().int().min(1).max(100000).optional(), seconds: z.number().int().min(5).max(3600).default(60) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid task payload' }); const payoutCents = Number(parsed.data.payoutCents ?? Math.round((parsed.data.amountDollars || 0) * 100)); const task = { id: nanoid(), clientId: req.session.user.id, title: parsed.data.title, videoUrl: parsed.data.videoUrl, seconds: parsed.data.seconds, description: parsed.data.description, payoutCents, createdAt: now() }; await db.query('INSERT INTO tasks (id,client_id,title,video_url,seconds,payout_cents,description,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [task.id, task.clientId, task.title, task.videoUrl, task.seconds, task.payoutCents, task.description, 'active', task.createdAt]); res.status(201).json({ task }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/complete', requireUser, async (req, res, next) => { try { const parsed = z.object({ watchedSeconds: z.number().int().min(0), proof: z.string().max(2000).optional() }).safeParse(req.body); const result = await db.query("SELECT * FROM tasks WHERE id=$1 AND status='active'", [req.params.id]); const task = result.rows[0]; if (!parsed.success || !task || parsed.data.watchedSeconds < task.seconds) return res.status(400).json({ error: 'Watch verification failed' }); await audit('task_reward', req.session.user.id, task.payout_cents, { taskId: task.id, proof: parsed.data.proof || null }); await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), req.session.user.id, 'wallet', `Verified task reward: ${(task.payout_cents / 100).toFixed(2)}`, now()]); res.json({ verified: true, payoutCents: task.payout_cents }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/purchase', requireUser, async (req, res, next) => { try { const parsed = z.object({ quantity: z.number().int().min(1).max(100000).default(1), targetUrl: z.string().url().optional(), notes: z.string().max(1000).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid task order details are required' }); const task = await db.query("SELECT * FROM tasks WHERE id=$1 AND status='active'", [req.params.id]); if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' }); const quantity = parsed.data.quantity; const subtotalCents = Number(task.rows[0].payout_cents) * quantity; const countryResult = await db.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]); const tax = calculateInternationalTax(subtotalCents, countryResult.rows[0]?.country || req.session.user.country); const amountCents = subtotalCents + tax.taxCents; await ensureWalletReady(req.session.user.id, amountCents); const feeCents = Math.round(amountCents * 0.05); const order = { id: nanoid(), taskId: req.params.id, buyerId: req.session.user.id, sellerId: task.rows[0].client_id, quantity, amountCents, feeCents, targetUrl: parsed.data.targetUrl || null, notes: parsed.data.notes || null, createdAt: now() }; await db.query('INSERT INTO task_orders (id,task_id,buyer_id,seller_id,quantity,amount_cents,fee_cents,status,target_url,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [order.id, order.taskId, order.buyerId, order.sellerId, order.quantity, order.amountCents, order.feeCents, 'paid', order.targetUrl, order.notes, order.createdAt]); await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'task_purchase', order.amountCents, 'paid', { taskId: order.taskId, quantity, subtotalCents, taxCents: tax.taxCents, internationalTax: tax.isInternational, feeCents: order.feeCents }, now()]); await updateTrustScoreOnSuccessfulTransaction(order.buyerId); res.status(201).json({ order, subtotalCents, taxCents: tax.taxCents, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents }); } catch (error) { next(error); } });

app.get('/api/listings', async (_req, res, next) => { try { const result = await db.query("SELECT id,title,type,price_cents AS \"priceCents\",status,created_at AS \"createdAt\" FROM listings WHERE status='active' ORDER BY created_at DESC"); res.json({ listings: result.rows }); } catch (error) { next(error); } });
app.post('/api/listings', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), type: z.enum(['physical', 'digital', 'service', 'software']), priceCents: z.number().int().min(1).max(100000000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid listing payload' }); const listing = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO listings (id,seller_id,title,type,price_cents,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [listing.id, listing.sellerId, listing.title, listing.type, listing.priceCents, 'active', listing.createdAt]); res.status(201).json({ listing }); } catch (error) { next(error); } });
app.post('/api/checkout/commission-split', requireUser, (req, res) => { const parsed = z.object({ grossCents: z.number().int().positive(), creatorPercent: z.number().min(0).max(100), platformPercent: z.number().min(0).max(100) }).safeParse(req.body); if (!parsed.success || parsed.data.creatorPercent + parsed.data.platformPercent > 100) return res.status(400).json({ error: 'Invalid commission split' }); const reservePercent = 100 - parsed.data.creatorPercent - parsed.data.platformPercent; res.json({ creatorCents: Math.round(parsed.data.grossCents * parsed.data.creatorPercent / 100), platformCents: Math.round(parsed.data.grossCents * parsed.data.platformPercent / 100), reserveCents: Math.round(parsed.data.grossCents * reservePercent / 100), reservePercent }); });
app.get('/api/wallet', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.session.user.id]); const debitKinds = new Set(['payout', 'product_purchase', 'gig_purchase', 'task_purchase', 'marketplace_purchase', 'premium_upgrade']); const balanceCents = result.rows.reduce((sum, row) => sum + (debitKinds.has(row.kind) ? -Number(row.amount_cents) : Number(row.amount_cents)), 0); res.json({ balanceCents, transactions: result.rows }); } catch (error) { next(error); } });
app.get('/api/wallet/cards', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM wallet_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.session.user.id]); res.json({ cards: result.rows }); } catch (error) { next(error); } });
app.post('/api/wallet/cards', requireUser, async (req, res, next) => { try { const parsed = z.object({ holderName: z.string().min(2).max(120), cardBrand: z.string().min(2).max(40), last4: z.string().regex(/^\d{4}$/), expiry: z.string().min(4).max(10) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid card details are required' }); const card = { id: nanoid(), userId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO wallet_cards (id,user_id,holder_name,card_brand,last4,expiry,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [card.id, card.userId, card.holderName, card.cardBrand, card.last4, card.expiry, card.createdAt]); res.status(201).json({ card }); } catch (error) { next(error); } });
app.post('/api/wallet/deposit', requireUser, (_req, res) => res.status(410).json({ error: 'Manual wallet deposits are disabled. Use a configured Stripe payment flow.' }));
app.get('/api/notifications', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.session.user.id]); res.json({ notifications: result.rows }); } catch (error) { next(error); } });
app.post('/api/disputes', requireUser, async (req, res, next) => { try { const parsed = z.object({ orderId: z.string().min(2).max(80), reason: z.string().min(10).max(3000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid dispute reason required' }); const dispute = { id: nanoid(), openedBy: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO disputes (id,opened_by,order_id,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [dispute.id, dispute.openedBy, dispute.orderId, dispute.reason, 'open', dispute.createdAt]); res.status(201).json({ dispute }); } catch (error) { next(error); } });
app.get('/forgot-password', (_req, res) => { res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TaskFlow | Reset Password</title><style>:root{font-family:Manrope,system-ui,sans-serif;color:#18231f;background:#f5f8f5;--green:#1f5d49;--dark:#123b30;--line:#dce5df;--muted:#718079;--mint:#dceee5}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#edf4ee,#f6faf7);display:grid;place-items:center;min-height:100vh;color:#183127}main{width:min(500px,92vw);padding:32px 28px;border-radius:18px;background:#fff;border:1px solid var(--line);box-shadow:0 18px 40px rgba(18,59,48,.08)}.brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:800;margin-bottom:18px}.brand b{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;color:#fff;background:var(--green)}h1{margin:0 0 10px;font-size:clamp(30px,5vw,42px);letter-spacing:-.05em}.subtitle{margin:0 0 18px;color:var(--muted);line-height:1.6}label{display:block;margin:16px 0 6px;font-size:12px;font-weight:700;color:var(--muted)}input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;color:#183127}.password-wrap{position:relative;display:flex;align-items:center} .password-wrap input{padding-right:44px}.toggle{position:absolute;right:10px;top:50%;transform:translateY(-50%);border:none;background:transparent;color:var(--green);font-weight:700;cursor:pointer;padding:8px}button{width:100%;padding:13px 14px;border:none;border-radius:10px;background:var(--green);color:#fff;font-weight:800;cursor:pointer;margin-top:12px}.secondary-link{display:inline-block;margin-top:16px;color:var(--green);text-decoration:none;font-weight:700}#message{margin-top:14px;padding:12px;border-radius:10px;background:#edf8ee;color:#234;display:none}#message.show{display:block}#message.error{background:#fff1f1;color:#8a1f1f}</style></head><body><main><div class="brand"><b>↗</b>taskflow</div><h1>Reset your password</h1><p class="subtitle">Enter your email and we’ll send a six-digit reset code to help you regain access.</p><form id="request-form"><label for="reset-email">Email address</label><input id="reset-email" type="email" required autocomplete="email"><button type="submit">Send reset code</button></form><form id="confirm-form" style="margin-top:20px"><label for="reset-code">Reset code</label><input id="reset-code" type="text" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" required><label for="new-password">New password</label><div class="password-wrap"><input id="new-password" type="password" minlength="6" required autocomplete="new-password"><button type="button" class="toggle" data-toggle="new-password">Show</button></div><button type="submit">Update password</button></form><div id="message"></div><p><a class="secondary-link" href="/">Back to sign in</a></p></main><script>const message=document.getElementById('message');function showMessage(text, isError=false){message.textContent=text;message.classList.add('show');message.classList.toggle('error', isError);message.style.display='block';}document.querySelectorAll('[data-toggle]').forEach((button)=>{button.addEventListener('click',()=>{const input=document.getElementById(button.dataset.toggle);const isPassword=input.type==='password';input.type=isPassword?'text':'password';button.textContent=isPassword?'Hide':'Show';});});document.getElementById('request-form').addEventListener('submit', async (event)=>{event.preventDefault();const email=document.getElementById('reset-email').value.trim();try{const response=await fetch('/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({email})});const data=await response.json();if(!response.ok) throw new Error(data.error || 'Unable to request reset');showMessage(data.message || 'Reset code sent.');}catch(error){showMessage(error.message,true);}});document.getElementById('confirm-form').addEventListener('submit', async (event)=>{event.preventDefault();const email=document.getElementById('reset-email').value.trim();const code=document.getElementById('reset-code').value.trim();const password=document.getElementById('new-password').value;try{const response=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({email,code,password})});const data=await response.json();if(!response.ok) throw new Error(data.error || 'Unable to reset password');showMessage(data.message || 'Password updated successfully.');setTimeout(()=>window.location.href='/', 1500);}catch(error){showMessage(error.message,true);}});</script></body></html>`); });
app.post('/api/chat/upload', requireUser, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'An image file is required.' });
    const image = await processAndEncryptImage(req.file.buffer);
    const id = nanoid();
    const filename = await saveEncryptedImage(image.payload, id);
    await db.query('INSERT INTO media_files (id,user_id,filename,mime_type,purpose) VALUES ($1,$2,$3,$4,$5)', [id, req.session.user.id, filename, image.mimeType, 'chat-media']);
    res.status(201).json({ file: { name: req.file.originalname, path: `/api/media/${id}`, size: req.file.size, mimeType: image.mimeType } });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/tasks/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Task not found' });
    await Promise.all([
      db.query('DELETE FROM task_applications WHERE task_id = $1', [req.params.id]),
      db.query('DELETE FROM task_submissions WHERE task_id = $1', [req.params.id]),
      db.query('DELETE FROM task_orders WHERE task_id = $1', [req.params.id]),
    ]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/media/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM media_files WHERE id = $1 RETURNING filename', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Upload not found' });
    await deleteEncryptedMedia(result.rows[0].filename);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/login', (req, res) => { const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(req.body); if (!parsed.success || parsed.data.username !== adminUsername || parsed.data.password !== adminPassword) return res.status(401).json({ error: 'Invalid admin credentials' }); req.session.user = { id: 'super-admin', name: adminUsername, role: 'admin', twoFactor: true, isAdmin: true }; res.json({ user: req.session.user }); });
app.get('/api/admin/overview', requireAdmin, async (_req, res, next) => { try { const [usersCount, escrow, disputesCount, listingsCount, productsCount, adsCount, gigsCount, categoriesCount, reportsCount, users, disputes, transactions, withdrawals] = await Promise.all([db.query('SELECT COUNT(*)::int AS count FROM users'), db.query('SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM transactions'), db.query("SELECT COUNT(*)::int AS count FROM disputes WHERE status='open'"), db.query("SELECT COUNT(*)::int AS count FROM listings WHERE status='flagged'"), db.query('SELECT COUNT(*)::int AS count FROM products'), db.query('SELECT COUNT(*)::int AS count FROM ads WHERE status = \'active\''), db.query('SELECT COUNT(*)::int AS count FROM gigs WHERE status = \'active\''), db.query('SELECT COUNT(*)::int AS count FROM categories'), db.query('SELECT COUNT(*)::int AS count FROM reports WHERE status = \'open\''), db.query('SELECT id,name,phone,email,role,trust_score AS "trustScore",two_factor AS "twoFactor",created_at AS "createdAt" FROM users ORDER BY created_at DESC LIMIT 100'), db.query('SELECT * FROM disputes ORDER BY created_at DESC LIMIT 100'), db.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100'), db.query('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 100')]); res.json({ stats: { activeUsers: usersCount.rows[0].count, escrowCents: escrow.rows[0].total, openDisputes: disputesCount.rows[0].count, flaggedListings: listingsCount.rows[0].count, activeProducts: productsCount.rows[0].count, activeAds: adsCount.rows[0].count, activeGigs: gigsCount.rows[0].count, categories: categoriesCount.rows[0].count, openReports: reportsCount.rows[0].count }, users: users.rows, disputes: disputes.rows, transactions: transactions.rows, withdrawals: withdrawals.rows }); } catch (error) { next(error); } });
app.get('/api/admin/users', requireAdmin, async (_req, res, next) => { try { const result = await db.query('SELECT id,name,email,phone,role,trust_score AS "trustScore",created_at AS "createdAt" FROM users ORDER BY created_at DESC'); res.json({ users: result.rows }); } catch (error) { next(error); } });
app.get('/api/admin/reports', requireAdmin, async (_req, res, next) => { try { const result = await db.query('SELECT * FROM reports ORDER BY created_at DESC'); res.json({ reports: result.rows }); } catch (error) { next(error); } });
app.get('/api/admin/categories', requireAdmin, async (_req, res, next) => { try { const result = await db.query('SELECT * FROM categories ORDER BY created_at DESC'); res.json({ categories: result.rows }); } catch (error) { next(error); } });
app.post('/api/admin/categories', requireAdmin, async (req, res, next) => { try { const parsed = z.object({ name: z.string().min(2).max(80), parentId: z.string().max(80).optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid category payload' }); const category = { id: nanoid(), ...parsed.data, createdAt: now() }; await db.query('INSERT INTO categories (id,name,parent_id,created_at) VALUES ($1,$2,$3,$4)', [category.id, category.name, category.parentId || null, category.createdAt]); res.status(201).json({ category }); } catch (error) { next(error); } });
app.post('/api/admin/disputes/:id/resolve', requireAdmin, async (req, res, next) => { try { const parsed = z.object({ resolution: z.string().min(3).max(2000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Resolution required' }); const result = await db.query("UPDATE disputes SET status='resolved',resolution=$1,resolved_at=$2 WHERE id=$3", [parsed.data.resolution, now(), req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Dispute not found' }); res.json({ resolved: true }); } catch (error) { next(error); } });
app.post('/api/admin/listings/:id/pause', requireAdmin, async (req, res, next) => { try { const result = await db.query("UPDATE listings SET status='paused' WHERE id=$1", [req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Listing not found' }); res.json({ paused: true }); } catch (error) { next(error); } });
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, _req, res, _next) => { console.error(error); res.status(Number(error.statusCode) || 500).json({ error: error.message || 'Internal server error' }); });

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket, request) => { const token = new URL(request.url, `http://${request.headers.host}`).searchParams.get('thread'); if (!token) return socket.close(1008, 'Thread required'); if (!sockets.has(token)) sockets.set(token, new Set()); sockets.get(token).add(socket); socket.on('message', raw => { let message; try { message = JSON.parse(raw.toString()); } catch { return; } const outgoing = JSON.stringify({ ...message, createdAt: now() }); for (const peer of sockets.get(token) || []) if (peer.readyState === 1) peer.send(outgoing); }); socket.on('close', () => sockets.get(token)?.delete(socket)); });
initializeSchema()
  .then(() => seedDemoData())
  .then(() => server.listen(port, '0.0.0.0', () => console.log(`TaskFlow listening on http://0.0.0.0:${port}`)))
  .catch(error => { console.error('PostgreSQL initialization failed:', error); process.exitCode = 1; });
