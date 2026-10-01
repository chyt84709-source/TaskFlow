import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

const router = express.Router();

const adMediaItem = z.union([
  z.string().min(1).refine((value) => value.startsWith('/') || /^https?:\/\//.test(value), 'Invalid media path'),
  z.object({ url: z.string().min(1), mimeType: z.string().min(1).max(100) })
]);
const adPayload = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(5).max(2000),
  category: z.string().trim().min(2).max(60),
  location: z.string().trim().min(2).max(120),
  priceCents: z.number().int().positive(),
  placement: z.string().trim().min(2).max(80).default('homepage-top'),
  durationDays: z.number().int().min(1).max(365).default(7),
  skipAllowed: z.boolean().default(true),
  media: z.array(adMediaItem).min(1).max(10),
  destinationUrl: z.string().url().max(500).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Invalid destination link').nullable().optional()
});

router.get('/api/ads/mine', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT id,title,description,category,location,price_cents AS "priceCents",placement,duration_days AS "durationDays",skip_allowed AS "skipAllowed",destination_url AS "destinationUrl",media,status,created_at AS "createdAt"
      FROM ads WHERE seller_id=$1 ORDER BY created_at DESC`, [req.session.user.id]);
    res.json({ ads: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/ads', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT * FROM ads WHERE status = 'active' AND created_at + (COALESCE(duration_days, 7) * INTERVAL '1 day') >= NOW() ORDER BY created_at DESC");
    const mediaIds = result.rows.flatMap((ad) => (Array.isArray(ad.media) ? ad.media : []))
      .map((item) => typeof item === 'string' ? item.match(/^\/api\/media\/([^/?#]+)/)?.[1] : null)
      .filter(Boolean);
    const mediaResult = mediaIds.length
      ? await db.query('SELECT id,mime_type AS "mimeType" FROM media_files WHERE id = ANY($1::text[])', [mediaIds])
      : { rows: [] };
    const mediaTypes = new Map(mediaResult.rows.map((item) => [item.id, item.mimeType]));
    const ads = result.rows.map((ad) => ({
      ...ad,
      media: (Array.isArray(ad.media) ? ad.media : []).map((item) => {
        if (typeof item !== 'string') return item;
        const mediaId = item.match(/^\/api\/media\/([^/?#]+)/)?.[1];
        return { url: item, mimeType: mediaTypes.get(mediaId) || '' };
      })
    }));
    res.json({ ads });
  } catch (error) {
    next(error);
  }
});

router.post('/api/ads', requireUser, async (req, res, next) => {
  try {
    const parsed = adPayload.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid ad payload. Check the title, category, duration, price, and uploaded media.' });

    const ad = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, destinationUrl: parsed.data.destinationUrl || null, media: parsed.data.media, createdAt: new Date().toISOString() };
    const isAdmin = req.session.user?.isAdmin || req.session.user?.role === 'admin';
    ad.status = isAdmin ? 'active' : 'pending';
    await db.query('INSERT INTO ads (id,seller_id,title,description,category,price_cents,location,media,status,placement,duration_days,skip_allowed,destination_url,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [ad.id, ad.sellerId, ad.title, ad.description, ad.category, ad.priceCents, ad.location, JSON.stringify(ad.media), ad.status, ad.placement, ad.durationDays, ad.skipAllowed, ad.destinationUrl, ad.createdAt]);
    res.status(201).json({ ad, submittedForReview: !isAdmin });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/ads/:id', requireUser, async (req, res, next) => {
  try {
    const parsed = adPayload.partial().safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data || {}).length) return res.status(400).json({ error: 'Enter at least one valid ad change.' });
    const columns = { title: 'title', description: 'description', category: 'category', location: 'location', priceCents: 'price_cents', placement: 'placement', durationDays: 'duration_days', skipAllowed: 'skip_allowed', media: 'media', destinationUrl: 'destination_url' };
    const values = [];
    const updates = Object.entries(parsed.data).map(([key, value]) => {
      values.push(key === 'media' ? JSON.stringify(value) : value);
      return `${columns[key]}=$${values.length}${key === 'media' ? '::jsonb' : ''}`;
    });
    const isAdmin = req.session.user?.isAdmin || req.session.user?.role === 'admin';
    if (!isAdmin) updates.push("status='pending'");
    values.push(req.params.id, req.session.user.id);
    const result = await db.query(`UPDATE ads SET ${updates.join(',')} WHERE id=$${values.length - 1} AND seller_id=$${values.length}
      RETURNING id,title,status`, values);
    if (!result.rows[0]) return res.status(404).json({ error: 'Ad not found for this account.' });
    res.json({ ad: result.rows[0], submittedForReview: !isAdmin });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/admin/ads/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM ads WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Ad not found' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/api/ads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const isAdmin = Boolean(req.session.user?.isAdmin || req.session.user?.role === 'admin');
    const result = await db.query(`SELECT m.id,m.ad_id AS "adId",m.sender_id AS "senderId",m.body,m.status,m.created_at AS "createdAt",u.name AS "senderName"
      FROM ad_messages m LEFT JOIN users u ON u.id=m.sender_id
      WHERE m.ad_id=$1 AND ($2=TRUE OR m.status='approved' OR m.sender_id=$3) ORDER BY m.created_at ASC`, [req.params.id, isAdmin, req.session.user.id]);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/ads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Message required' });

    const ad = await db.query("SELECT id FROM ads WHERE id=$1 AND status='active'", [req.params.id]);
    if (!ad.rows[0]) return res.status(404).json({ error: 'Advertisement not found.' });
    const message = { id: nanoid(), adId: req.params.id, senderId: req.session.user.id, body: parsed.data.body, status: 'pending', createdAt: new Date().toISOString() };
    await db.query('INSERT INTO ad_messages (id,ad_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, message.adId, message.senderId, message.body, message.createdAt]);
    res.status(201).json({ message, reviewStatus: 'pending' });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/ads', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT a.*,u.name AS owner_name,u.email AS owner_email FROM ads a
      LEFT JOIN users u ON u.id=a.seller_id ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,a.created_at DESC`);
    const mediaIds = result.rows.flatMap((ad) => Array.isArray(ad.media) ? ad.media : [])
      .map((item) => typeof item === 'string' ? item.match(/^\/api\/media\/([^/?#]+)/)?.[1] : item?.url?.match(/^\/api\/media\/([^/?#]+)/)?.[1])
      .filter(Boolean);
    const mediaResult = mediaIds.length ? await db.query('SELECT id,mime_type AS "mimeType" FROM media_files WHERE id=ANY($1::text[])', [mediaIds]) : { rows: [] };
    const mediaTypes = new Map(mediaResult.rows.map((file) => [file.id, file.mimeType]));
    const ads = result.rows.map((ad) => ({ ...ad, media: (Array.isArray(ad.media) ? ad.media : []).map((item) => {
      const url = typeof item === 'string' ? item : item?.url;
      const mediaId = url?.match(/^\/api\/media\/([^/?#]+)/)?.[1];
      return url ? { url, mimeType: mediaTypes.get(mediaId) || item?.mimeType || '' } : null;
    }).filter(Boolean) }));
    res.json({ ads });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/admin/ads/:id/review', requireAdmin, async (req, res, next) => {
  const parsed = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose approve or reject.' });
  try {
    const result = await db.query(`UPDATE ads SET status=$1,created_at=CASE WHEN $1='active' THEN NOW() ELSE created_at END
      WHERE id=$2 RETURNING id,status`, [parsed.data.decision === 'approved' ? 'active' : 'rejected', req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Advertisement not found.' });
    res.json({ reviewed: true, ad: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/ad-messages', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT m.id,m.ad_id AS "adId",m.sender_id AS "senderId",m.body,m.status,m.created_at AS "createdAt",
      u.name AS "senderName",u.email AS "senderEmail",a.title AS "adTitle"
      FROM ad_messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN ads a ON a.id=m.ad_id
      ORDER BY CASE m.status WHEN 'pending' THEN 0 ELSE 1 END,m.created_at DESC`);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/admin/ad-messages/:id/review', requireAdmin, async (req, res, next) => {
  const parsed = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose approve or reject.' });
  try {
    const result = await db.query('UPDATE ad_messages SET status=$1 WHERE id=$2 RETURNING id,status', [parsed.data.decision, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Advertisement message not found.' });
    res.json({ reviewed: true, message: result.rows[0] });
  } catch (error) {
    next(error);
  }
});


export default router;
