import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, hash, issueOtp, normalizeCountry, reqOtp } from '../config/database.js';
import { hashPassword, now, requireUser, verifyPassword } from '../utils/helpers.js';

const router = express.Router();

router.post('/api/auth/signup', async (req, res, next) => {
  try {
    const parsed = z.object({
      email: z.string().email().max(320),
      password: z.string().min(6).max(128),
      name: z.string().min(1).max(100),
      role: z.enum(['worker', 'client']).default('worker'),
      subscriptionTier: z.enum(['standard', 'premium']).default('standard'),
      country: z.string().max(80).default('US'),
      referralCode: z.string().max(80).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid name, email, password, and role are required' });

    const email = parsed.data.email.toLowerCase();
    const existing = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });

    const passwordHash = hashPassword(parsed.data.password);
    const user = { id: nanoid(), email, name: parsed.data.name.trim(), role: parsed.data.role, country: normalizeCountry(parsed.data.country), subscription_tier: 'standard', trust_score: null, two_factor: false, password_hash: passwordHash, referral_code: nanoid(16), created_at: now() };
    await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,password_hash,referral_code,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.password_hash, user.referral_code, user.created_at]);
    if (parsed.data.referralCode) {
      await db.query("INSERT INTO referrals (id,referrer_id,referred_user_id,referral_code,status,created_at) SELECT $1,id,$2,referral_code,'pending',$3 FROM users WHERE referral_code=$4 AND id <> $2 ON CONFLICT (referred_user_id) DO NOTHING", [nanoid(), user.id, user.created_at, parsed.data.referralCode]);
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: user.country, subscriptionTier: user.subscription_tier, trustScore: user.trust_score, twoFactor: false, isAdmin: false };
    res.status(201).json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/login', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320), password: z.string().min(6).max(128) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Email and password are required' });

    const email = parsed.data.email.toLowerCase();
    const userResult = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = userResult.rows[0];
    if (!user || !user.password_hash || !verifyPassword(parsed.data.password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: user.role === 'admin' };
    res.json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/forgot-password', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid email address required' });

    const email = parsed.data.email.toLowerCase();
    const userResult = await db.query('SELECT id, name, email FROM users WHERE email=$1', [email]);
    if (!userResult.rows[0]) return res.json({ ok: true, message: 'If an account exists for that email, a password reset code has been sent.' });

    const code = issueOtp(email);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${process.env.RESEND_FROM_NAME || 'TaskFlow'} <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
          to: [email],
          subject: 'Your TaskFlow verification code',
          html: `<p>Your TaskFlow verification code is <strong>${code}</strong>.</p><p>This code expires in five minutes.</p>`,
        }),
      });
      if (!response.ok) throw new Error('Resend email request failed');
    } catch (error) {
      return res.status(502).json({ error: 'Unable to deliver password reset email. Please try again shortly.' });
    }

    res.json({ ok: true, message: 'A password reset code has been sent to your email.' });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/), password: z.string().min(6).max(128) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Email, reset code, and a new password are required' });

    const email = parsed.data.email.toLowerCase();
    const records = reqOtp.get(email);
    const digest = hash(parsed.data.code);
    if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired reset code' });
    records.delete(digest);

    const passwordHash = hashPassword(parsed.data.password);
    await db.query('UPDATE users SET password_hash=$1 WHERE email=$2', [passwordHash, email]);
    res.json({ ok: true, message: 'Password updated successfully. You can sign in with your new password.' });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/email/request', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid email address required' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email verification is not configured on this deployment.' });

    const code = issueOtp(parsed.data.email.toLowerCase());
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${process.env.RESEND_FROM_NAME || 'TaskFlow'} <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
          to: [parsed.data.email.toLowerCase()],
          subject: 'Your TaskFlow verification code',
          html: `<p>Your TaskFlow verification code is <strong>${code}</strong>.</p><p>This code expires in five minutes.</p>`,
        }),
      });
      if (!response.ok) throw new Error('Resend email request failed');
    } catch (error) {
      return res.status(502).json({ error: 'Unable to deliver verification email. Please try again shortly.' });
    }

    res.json({ ok: true, expiresIn: 300 });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/email/verify', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(100).optional(), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' });

    const email = parsed.data.email.toLowerCase();
    const records = reqOtp.get(email);
    const digest = hash(parsed.data.code);
    if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' });
    records.delete(digest);

    const result = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    let user = result.rows[0];
    if (!user) {
      user = { id: nanoid(), email, name: parsed.data.name || email.split('@')[0], role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, created_at: now() };
      await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.created_at]);
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false };
    res.json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/register', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email().max(320), name: z.string().min(1).max(100), password: z.string().min(6).max(128).optional(), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid name, email, and password are required' });

    const email = parsed.data.email.toLowerCase();
    const existing = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (existing.rows[0]) return res.status(409).json({ error: 'This email is already registered. Please sign in.' });

    const passwordHash = parsed.data.password ? hashPassword(parsed.data.password) : hashPassword('temporary-password');
    const user = { id: nanoid(), email, name: parsed.data.name.trim(), role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, password_hash: passwordHash, created_at: now() };
    await db.query('INSERT INTO users (id,email,name,role,country,subscription_tier,trust_score,two_factor,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [user.id, user.email, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.password_hash, user.created_at]);

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: false, isAdmin: false };
    res.status(201).json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

router.post('/api/auth/phone/request', (_req, res) => res.status(503).json({ error: 'Phone verification is not configured. Use email verification or configure a phone provider.' }));

router.post('/api/auth/phone/verify', async (req, res, next) => {
  try {
    const parsed = z.object({ phone: z.string().min(7).max(20), code: z.string().regex(/^\d{6}$/), name: z.string().max(100).optional(), role: z.enum(['worker', 'client', 'admin']).default('worker') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' });

    const records = reqOtp.get(parsed.data.phone);
    const digest = hash(parsed.data.code);
    if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' });
    records.delete(digest);

    const result = await db.query('SELECT * FROM users WHERE phone=$1', [parsed.data.phone]);
    let user = result.rows[0];
    if (!user) {
      user = { id: nanoid(), phone: parsed.data.phone, name: parsed.data.name || 'TaskFlow member', role: parsed.data.role, country: 'US', subscription_tier: 'standard', trust_score: null, two_factor: false, created_at: now() };
      await db.query('INSERT INTO users (id,phone,name,role,country,subscription_tier,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [user.id, user.phone, user.name, user.role, user.country, user.subscription_tier, user.trust_score, false, user.created_at]);
    }

    req.session.user = { id: user.id, name: user.name, email: user.email || null, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false };
    res.json({ user: req.session.user });
  } catch (error) {
    next(error);
  }
});

router.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(501).json({ error: 'Google OAuth is not configured' });
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback')}&response_type=code&scope=openid%20email%20profile&state=${state}&prompt=select_account`);
});

router.get('/api/auth/google/callback', async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || req.query.error) return res.redirect('/?auth=google-failed');
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).json({ error: 'Invalid OAuth state' });
    delete req.session.oauthState;

    const code = String(req.query.code || '');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback',
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) throw new Error('Google OAuth token exchange failed');
    const tokens = await tokenResponse.json();
    const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await userInfoResponse.json();
    if (!profile?.email) return res.status(400).json({ error: 'Google account has no email' });

    const result = await db.query('INSERT INTO users (id,email,name,role,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING *', [nanoid(), profile.email, profile.name || 'TaskFlow member', 'worker', null, false, now()]);
    const user = result.rows[0];
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, country: normalizeCountry(user.country || 'US'), subscriptionTier: user.subscription_tier || 'standard', trustScore: user.trust_score ?? null, twoFactor: Boolean(user.two_factor), isAdmin: false };
    res.redirect('/?auth=google-success');
  } catch (error) {
    next(error);
  }
});

router.post('/api/auth/2fa/enable', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Six-digit code required' });
    await db.query('UPDATE users SET two_factor=TRUE WHERE id=$1', [req.session.user.id]);
    req.session.user.twoFactor = true;
    res.json({ enabled: true });
  } catch (error) {
    next(error);
  }
});

export default router;
