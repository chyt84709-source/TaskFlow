import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const reqOtp = new Map();

export function hash(value) {
  return crypto.createHash('sha256').update(`${value}:${process.env.SESSION_SECRET || 'development-only'}`).digest('hex');
}

export function issueOtp(identifier) {
  const code = String(crypto.randomInt(100000, 1000000));
  const digest = hash(code);
  if (!reqOtp.has(identifier)) reqOtp.set(identifier, new Map());
  reqOtp.get(identifier).set(digest, Date.now() + 5 * 60 * 1000);
  return code;
}

export async function audit(kind, userId, amountCents = 0, metadata = {}) {
  await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), userId, kind, amountCents, 'recorded', metadata, new Date().toISOString()]);
}

export const COUNTRY_CURRENCY = {
  US: { code: 'USD', symbol: '$', rate: 1 },
  PK: { code: 'PKR', symbol: '₨', rate: 278 },
  IN: { code: 'INR', symbol: '₹', rate: 83 },
  AE: { code: 'AED', symbol: 'د.إ', rate: 3.67 },
  GB: { code: 'GBP', symbol: '£', rate: 0.79 },
  CA: { code: 'CAD', symbol: 'C$', rate: 1.36 },
  SA: { code: 'SAR', symbol: '﷼', rate: 3.75 },
  BD: { code: 'BDT', symbol: '৳', rate: 108 },
  NG: { code: 'NGN', symbol: '₦', rate: 1500 },
};

export function normalizeCountry(country) {
  const code = String(country || 'US').trim().toUpperCase();
  return COUNTRY_CURRENCY[code] ? code : 'US';
}

export function getCurrencyMeta(country) {
  return COUNTRY_CURRENCY[normalizeCountry(country)] || COUNTRY_CURRENCY.US;
}

export async function initializeSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, name TEXT, role TEXT NOT NULL DEFAULT 'worker', country TEXT, subscription_tier TEXT NOT NULL DEFAULT 'standard', trust_score DOUBLE PRECISION DEFAULT NULL, two_factor BOOLEAN NOT NULL DEFAULT FALSE, password_hash TEXT, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT NOT NULL, referred_user_id TEXT UNIQUE NOT NULL, referral_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, client_id TEXT, title TEXT NOT NULL, video_url TEXT NOT NULL, seconds INTEGER NOT NULL, payout_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, seller_id TEXT, title TEXT NOT NULL, type TEXT NOT NULL, price_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, metadata JSONB, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS disputes (id TEXT PRIMARY KEY, opened_by TEXT, order_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT, attachment TEXT, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, media JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, user_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS cart_items (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, product_id));
    CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, location TEXT NOT NULL, media JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS ad_messages (id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS gigs (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, delivery_days INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, gig_id TEXT NOT NULL, buyer_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, bio TEXT, location TEXT, avatar_url TEXT, skills TEXT, social_links JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS favorites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, target_type, target_id));
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS service_orders (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, package_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', delivery_text TEXT, revisions INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_applications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_submissions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, proof_url TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'submitted', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS wallet_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, holder_name TEXT NOT NULL, card_brand TEXT NOT NULL, last4 TEXT NOT NULL, expiry TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS task_orders (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', target_url TEXT, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS product_orders (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS gig_orders (id TEXT PRIMARY KEY, gig_id TEXT NOT NULL, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL, package_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_product_idx ON reviews (product_id, user_id);`);

  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'standard'; ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score DOUBLE PRECISION; ALTER TABLE users ALTER COLUMN trust_score DROP NOT NULL; ALTER TABLE users ALTER COLUMN trust_score SET DEFAULT NULL; ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE; ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_source TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_activated_at TIMESTAMPTZ; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_by TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_url TEXT; ALTER TABLE tasks ADD COLUMN IF NOT EXISTS qualification TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS description TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS category TEXT; ALTER TABLE listings ADD COLUMN IF NOT EXISTS location TEXT; ALTER TABLE ads ADD COLUMN IF NOT EXISTS placement TEXT DEFAULT 'homepage-top'; ALTER TABLE ads ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 7; ALTER TABLE ads ADD COLUMN IF NOT EXISTS skip_allowed BOOLEAN DEFAULT TRUE; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS portfolio TEXT; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS seller_level TEXT; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS basic_price_cents INTEGER; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS standard_price_cents INTEGER; ALTER TABLE gigs ADD COLUMN IF NOT EXISTS premium_price_cents INTEGER;`);
}

export async function seedDemoData() {
  // Production starts with empty marketplace and wallet state.
}

export function now() {
  return new Date().toISOString();
}
