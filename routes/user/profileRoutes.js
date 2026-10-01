import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, normalizeCountry } from '../../config/database.js';
import { requireUser } from '../../utils/helpers.js';

const router = express.Router();

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
      category: z.string().max(120).optional(),
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

    await db.query(`INSERT INTO profiles (id, user_id, bio, location, avatar_url, skills, category, social_links, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, location = EXCLUDED.location, avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url), skills = EXCLUDED.skills, category = EXCLUDED.category`, [nanoid(), req.session.user.id, values.bio || null, values.location || null, values.avatarUrl || null, values.skills || null, values.category || null, JSON.stringify({}), new Date().toISOString()]);

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

export default router;
