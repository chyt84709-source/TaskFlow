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

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
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
if (!process.env.SESSION_SECRET || !adminUsername || !adminPassword) throw new Error('SESSION_SECRET, SUPER_ADMIN_USERNAME, and SUPER_ADMIN_PASSWORD are required.');
if (process.env.NODE_ENV === 'production' && !emailEnabled) throw new Error('RESEND_API_KEY and RESEND_FROM_EMAIL are required in production.');

function hash(value) { return crypto.createHash('sha256').update(`${value}:${process.env.SESSION_SECRET || 'development-only'}`).digest('hex'); }
function now() { return new Date().toISOString(); }
async function initializeSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, name TEXT, role TEXT NOT NULL DEFAULT 'worker', trust_score DOUBLE PRECISION NOT NULL DEFAULT 0, two_factor BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, client_id TEXT, title TEXT NOT NULL, video_url TEXT NOT NULL, seconds INTEGER NOT NULL, payout_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, seller_id TEXT, title TEXT NOT NULL, type TEXT NOT NULL, price_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, metadata JSONB, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS disputes (id TEXT PRIMARY KEY, opened_by TEXT, order_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT, attachment TEXT, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);`);
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT');
}

async function sendOtpEmail({ to, code }) {
  if (!emailEnabled || !to) return;

  const payload = {
    from: `${resendFromName} <${resendFromEmail}>`,
    to: Array.isArray(to) ? to : [to],
    subject: 'Your TaskFlow verification code',
    html: `<p>Your TaskFlow verification code is <strong>${code}</strong>.</p><p>This code expires in five minutes.</p>`,
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
    throw new Error(`Resend OTP email request failed (${response.status}): ${text}`);
  }
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({ name: 'taskflow.sid', keys: [process.env.SESSION_SECRET || 'local-development-secret'], httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ storage: multer.diskStorage({ destination: uploadDir, filename: (_req, file, cb) => cb(null, `${nanoid()}${path.extname(file.originalname)}`) }), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /^(image|application|text|video)\//.test(file.mimetype)) });

function requireUser(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Authentication required' }); next(); }
function requireAdmin(req, res, next) { if (!req.session.user?.isAdmin) return res.status(403).json({ error: 'Super-admin access required' }); next(); }
async function audit(kind, userId, amountCents = 0, metadata = {}) { await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), userId, kind, amountCents, 'recorded', metadata, now()]); }
function issueOtp(identifier) { const code = String(crypto.randomInt(100000, 1000000)); const digest = hash(code); if (!reqOtp.has(identifier)) reqOtp.set(identifier, new Map()); reqOtp.get(identifier).set(digest, Date.now() + 5 * 60 * 1000); return code; }
const reqOtp = new Map();

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'taskflow', time: now() }));
app.get('/api/summary', async (_req, res, next) => { try { const [users, tasks, listings, paid] = await Promise.all([db.query('SELECT COUNT(*)::int AS count FROM users'), db.query("SELECT COUNT(*)::int AS count FROM tasks WHERE status='active'"), db.query("SELECT COUNT(*)::int AS count FROM listings WHERE status='active'"), db.query("SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM transactions WHERE amount_cents > 0")]); res.json({ users: users.rows[0].count, activeTasks: tasks.rows[0].count, activeListings: listings.rows[0].count, paidCents: paid.rows[0].total }); } catch (error) { next(error); } });
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
app.post('/api/auth/email/request', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid email address required' }); if (!emailEnabled) return res.status(503).json({ error: 'Email verification is not configured on this deployment.' }); const code = issueOtp(parsed.data.email.toLowerCase()); try { await sendOtpEmail({ to: parsed.data.email, code }); } catch (error) { console.error('Sign-in email delivery failed:', error.message || error); return res.status(502).json({ error: 'Unable to deliver verification email. Please try again shortly.' }); } res.json({ ok: true, expiresIn: 300 }); } catch (error) { next(error); } });
app.post('/api/auth/email/verify', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(100).optional(), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' }); const email = parsed.data.email.toLowerCase(); const records = reqOtp.get(email); const digest = hash(parsed.data.code); if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' }); records.delete(digest); const result = await db.query('SELECT * FROM users WHERE email=$1', [email]); let user = result.rows[0]; if (!user) { user = { id: nanoid(), email, name: parsed.data.name || email.split('@')[0], role: parsed.data.role, trust_score: 0, two_factor: false, created_at: now() }; await db.query('INSERT INTO users (id,email,name,role,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [user.id, user.email, user.name, user.role, 0, false, user.created_at]); } req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.json({ user: req.session.user }); } catch (error) { next(error); } });
app.post('/api/auth/register', async (req, res, next) => { try { const parsed = z.object({ email: z.string().email().max(320), name: z.string().min(1).max(100), role: z.enum(['worker', 'client']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid name, email, and role are required' }); if (!emailEnabled) return res.status(503).json({ error: 'Email verification is not configured on this deployment.' }); const email = parsed.data.email.toLowerCase(); const code = issueOtp(email); try { await sendOtpEmail({ to: email, code }); } catch (error) { console.error('Registration email delivery failed:', error.message || error); return res.status(502).json({ error: 'Unable to deliver verification email. Please try again shortly.' }); } res.json({ ok: true, expiresIn: 300, profile: { email, name: parsed.data.name, role: parsed.data.role } }); } catch (error) { next(error); } });
app.post('/api/auth/phone/request', (_req, res) => res.status(503).json({ error: 'Phone verification is not configured. Use email verification or configure a phone provider.' }));
app.post('/api/auth/phone/verify', async (req, res, next) => { try { const parsed = z.object({ phone: z.string().min(7).max(20), code: z.string().regex(/^\d{6}$/), name: z.string().max(100).optional(), role: z.enum(['worker', 'client', 'admin']).default('worker') }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' }); const records = reqOtp.get(parsed.data.phone); const digest = hash(parsed.data.code); if (!records?.has(digest) || records.get(digest) < Date.now()) return res.status(401).json({ error: 'Invalid or expired code' }); records.delete(digest); const result = await db.query('SELECT * FROM users WHERE phone=$1', [parsed.data.phone]); let user = result.rows[0]; if (!user) { user = { id: nanoid(), phone: parsed.data.phone, name: parsed.data.name || 'TaskFlow member', role: parsed.data.role, trust_score: 0, two_factor: false, created_at: now() }; await db.query('INSERT INTO users (id,phone,name,role,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [user.id, user.phone, user.name, user.role, 0, false, user.created_at]); } req.session.user = { id: user.id, name: user.name, role: user.role, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.json({ user: req.session.user }); } catch (error) { next(error); } });
app.get('/api/auth/google', (req, res) => { if (!googleClient) return res.status(501).json({ error: 'Google OAuth is not configured' }); const state = crypto.randomBytes(24).toString('hex'); req.session.oauthState = state; res.redirect(googleClient.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' })); });
app.get('/api/auth/google/callback', async (req, res, next) => { try { if (!googleClient || req.query.error) return res.redirect('/?auth=google-failed'); if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).json({ error: 'Invalid OAuth state' }); delete req.session.oauthState; const { tokens } = await googleClient.getToken(String(req.query.code)); const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID }); const profile = ticket.getPayload(); if (!profile?.email) return res.status(400).json({ error: 'Google account has no email' }); const result = await db.query('INSERT INTO users (id,email,name,role,trust_score,two_factor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING *', [nanoid(), profile.email, profile.name || 'TaskFlow member', 'worker', 0, false, now()]); const user = result.rows[0]; req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, twoFactor: Boolean(user.two_factor), isAdmin: false }; res.redirect('/?auth=google-success'); } catch (error) { next(error); } });
app.post('/api/auth/logout', (req, res) => { req.session = null; res.status(204).end(); });
app.post('/api/auth/2fa/enable', requireUser, async (req, res, next) => { try { const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Six-digit code required' }); await db.query('UPDATE users SET two_factor=TRUE WHERE id=$1', [req.session.user.id]); req.session.user.twoFactor = true; await audit('2fa_enabled', req.session.user.id, 0); res.json({ enabled: true }); } catch (error) { next(error); } });

app.get('/api/tasks', async (_req, res, next) => { try { const result = await db.query("SELECT id,title,video_url AS \"videoUrl\",seconds,payout_cents AS \"payoutCents\",status,created_at AS \"createdAt\" FROM tasks WHERE status='active' ORDER BY created_at DESC"); res.json({ tasks: result.rows }); } catch (error) { next(error); } });
app.post('/api/tasks', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), videoUrl: z.string().url(), seconds: z.number().int().min(5).max(3600), payoutCents: z.number().int().min(1).max(100000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid task payload' }); const task = { id: nanoid(), clientId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO tasks (id,client_id,title,video_url,seconds,payout_cents,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [task.id, task.clientId, task.title, task.videoUrl, task.seconds, task.payoutCents, 'active', task.createdAt]); res.status(201).json({ task }); } catch (error) { next(error); } });
app.post('/api/tasks/:id/complete', requireUser, async (req, res, next) => { try { const parsed = z.object({ watchedSeconds: z.number().int().min(0), proof: z.string().max(2000).optional() }).safeParse(req.body); const result = await db.query("SELECT * FROM tasks WHERE id=$1 AND status='active'", [req.params.id]); const task = result.rows[0]; if (!parsed.success || !task || parsed.data.watchedSeconds < task.seconds) return res.status(400).json({ error: 'Watch verification failed' }); await audit('task_reward', req.session.user.id, task.payout_cents, { taskId: task.id, proof: parsed.data.proof || null }); await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), req.session.user.id, 'wallet', `Verified task reward: ${(task.payout_cents / 100).toFixed(2)}`, now()]); res.json({ verified: true, payoutCents: task.payout_cents }); } catch (error) { next(error); } });

app.get('/api/listings', async (_req, res, next) => { try { const result = await db.query("SELECT id,title,type,price_cents AS \"priceCents\",status,created_at AS \"createdAt\" FROM listings WHERE status='active' ORDER BY created_at DESC"); res.json({ listings: result.rows }); } catch (error) { next(error); } });
app.post('/api/listings', requireUser, async (req, res, next) => { try { const parsed = z.object({ title: z.string().min(3).max(160), type: z.enum(['physical', 'digital', 'service', 'software']), priceCents: z.number().int().min(1).max(100000000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid listing payload' }); const listing = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO listings (id,seller_id,title,type,price_cents,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [listing.id, listing.sellerId, listing.title, listing.type, listing.priceCents, 'active', listing.createdAt]); res.status(201).json({ listing }); } catch (error) { next(error); } });
app.post('/api/checkout/commission-split', requireUser, (req, res) => { const parsed = z.object({ grossCents: z.number().int().positive(), creatorPercent: z.number().min(0).max(100), platformPercent: z.number().min(0).max(100) }).safeParse(req.body); if (!parsed.success || parsed.data.creatorPercent + parsed.data.platformPercent > 100) return res.status(400).json({ error: 'Invalid commission split' }); const reservePercent = 100 - parsed.data.creatorPercent - parsed.data.platformPercent; res.json({ creatorCents: Math.round(parsed.data.grossCents * parsed.data.creatorPercent / 100), platformCents: Math.round(parsed.data.grossCents * parsed.data.platformPercent / 100), reserveCents: Math.round(parsed.data.grossCents * reservePercent / 100), reservePercent }); });
app.get('/api/wallet', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.session.user.id]); const balanceCents = result.rows.reduce((sum, row) => sum + (row.kind === 'payout' ? -row.amount_cents : row.amount_cents), 0); res.json({ balanceCents, transactions: result.rows }); } catch (error) { next(error); } });
app.get('/api/notifications', requireUser, async (req, res, next) => { try { const result = await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.session.user.id]); res.json({ notifications: result.rows }); } catch (error) { next(error); } });
app.post('/api/disputes', requireUser, async (req, res, next) => { try { const parsed = z.object({ orderId: z.string().min(2).max(80), reason: z.string().min(10).max(3000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Valid dispute reason required' }); const dispute = { id: nanoid(), openedBy: req.session.user.id, ...parsed.data, createdAt: now() }; await db.query('INSERT INTO disputes (id,opened_by,order_id,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [dispute.id, dispute.openedBy, dispute.orderId, dispute.reason, 'open', dispute.createdAt]); res.status(201).json({ dispute }); } catch (error) { next(error); } });
app.post('/api/chat/upload', requireUser, upload.single('file'), (req, res) => res.status(201).json({ file: { name: req.file.originalname, path: `/uploads/${req.file.filename}`, size: req.file.size } }));

app.post('/api/admin/login', (req, res) => { const parsed = z.object({ username: z.string(), password: z.string() }).safeParse(req.body); if (!parsed.success || parsed.data.username !== adminUsername || parsed.data.password !== adminPassword) return res.status(401).json({ error: 'Invalid admin credentials' }); req.session.user = { id: 'super-admin', name: adminUsername, role: 'admin', twoFactor: true, isAdmin: true }; res.json({ user: req.session.user }); });
app.get('/api/admin/overview', requireAdmin, async (_req, res, next) => { try { const [usersCount, escrow, disputesCount, listingsCount, users, disputes, transactions] = await Promise.all([db.query('SELECT COUNT(*)::int AS count FROM users'), db.query('SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM transactions'), db.query("SELECT COUNT(*)::int AS count FROM disputes WHERE status='open'"), db.query("SELECT COUNT(*)::int AS count FROM listings WHERE status='flagged'"), db.query('SELECT id,name,phone,email,role,trust_score AS "trustScore",two_factor AS "twoFactor",created_at AS "createdAt" FROM users ORDER BY created_at DESC LIMIT 100'), db.query('SELECT * FROM disputes ORDER BY created_at DESC LIMIT 100'), db.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100')]); res.json({ stats: { activeUsers: usersCount.rows[0].count, escrowCents: escrow.rows[0].total, openDisputes: disputesCount.rows[0].count, flaggedListings: listingsCount.rows[0].count }, users: users.rows, disputes: disputes.rows, transactions: transactions.rows }); } catch (error) { next(error); } });
app.post('/api/admin/disputes/:id/resolve', requireAdmin, async (req, res, next) => { try { const parsed = z.object({ resolution: z.string().min(3).max(2000) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Resolution required' }); const result = await db.query("UPDATE disputes SET status='resolved',resolution=$1,resolved_at=$2 WHERE id=$3", [parsed.data.resolution, now(), req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Dispute not found' }); res.json({ resolved: true }); } catch (error) { next(error); } });
app.post('/api/admin/listings/:id/pause', requireAdmin, async (req, res, next) => { try { const result = await db.query("UPDATE listings SET status='paused' WHERE id=$1", [req.params.id]); if (!result.rowCount) return res.status(404).json({ error: 'Listing not found' }); res.json({ paused: true }); } catch (error) { next(error); } });
app.get('/uploads', express.static(uploadDir, { dotfiles: 'deny', index: false }));
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: 'Internal server error' }); });

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket, request) => { const token = new URL(request.url, `http://${request.headers.host}`).searchParams.get('thread'); if (!token) return socket.close(1008, 'Thread required'); if (!sockets.has(token)) sockets.set(token, new Set()); sockets.get(token).add(socket); socket.on('message', raw => { let message; try { message = JSON.parse(raw.toString()); } catch { return; } const outgoing = JSON.stringify({ ...message, createdAt: now() }); for (const peer of sockets.get(token) || []) if (peer.readyState === 1) peer.send(outgoing); }); socket.on('close', () => sockets.get(token)?.delete(socket)); });
initializeSchema().then(() => server.listen(port, '0.0.0.0', () => console.log(`TaskFlow listening on http://0.0.0.0:${port}`))).catch(error => { console.error('PostgreSQL initialization failed:', error); process.exitCode = 1; });
