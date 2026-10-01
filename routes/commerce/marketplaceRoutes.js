import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

const router = express.Router();

router.get('/api/gigs', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT * FROM gigs WHERE status='active' ORDER BY created_at DESC");
    const portfolioByGig = new Map(result.rows.map((gig) => {
      let portfolio = gig.portfolio;
      if (typeof portfolio === 'string') {
        try {
          portfolio = JSON.parse(portfolio);
        } catch {
          portfolio = portfolio ? [portfolio] : [];
        }
      }
      return [gig.id, Array.isArray(portfolio) ? portfolio : []];
    }));
    const mediaIds = [...portfolioByGig.values()].flat()
      .map((item) => typeof item === 'string' ? item.match(/^\/api\/media\/([^/?#]+)/)?.[1] : item?.url?.match(/^\/api\/media\/([^/?#]+)/)?.[1])
      .filter(Boolean);
    const mediaResult = mediaIds.length
      ? await db.query('SELECT id,mime_type AS "mimeType" FROM media_files WHERE id = ANY($1::text[])', [mediaIds])
      : { rows: [] };
    const mediaTypes = new Map(mediaResult.rows.map((item) => [item.id, item.mimeType]));
    const gigs = result.rows.map((gig) => ({
      ...gig,
      portfolioMedia: (portfolioByGig.get(gig.id) || []).map((item) => {
        const url = typeof item === 'string' ? item : item?.url;
        const mediaId = url?.match(/^\/api\/media\/([^/?#]+)/)?.[1];
        return url ? { url, mimeType: mediaTypes.get(mediaId) || item?.mimeType || '' } : null;
      }).filter(Boolean),
    }));
    res.json({ gigs });
  } catch (error) {
    next(error);
  }
});

router.post('/api/gigs', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(10).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), deliveryDays: z.number().int().min(1).max(30).default(3), portfolioMedia: z.array(z.string().min(1)).default([]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid gig payload' });

    const priceCents = Number(parsed.data.priceCents ?? Math.round((parsed.data.priceDollars || 0) * 100));
    const gig = { id: nanoid(), sellerId: req.session.user.id, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, priceCents, deliveryDays: parsed.data.deliveryDays, portfolioMedia: parsed.data.portfolioMedia, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO gigs (id,seller_id,title,description,category,price_cents,delivery_days,portfolio,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [gig.id, gig.sellerId, gig.title, gig.description, gig.category, gig.priceCents, gig.deliveryDays, JSON.stringify(gig.portfolioMedia), 'active', gig.createdAt]);
    res.status(201).json({ gig });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/admin/gigs/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM gigs WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Gig not found' });
    await db.query('DELETE FROM proposals WHERE gig_id = $1', [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/api/gigs/:id/purchase', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ packageName: z.string().min(2).max(80).default('Standard'), notes: z.string().max(1000).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid gig purchase details are required' });

    const gig = await db.query('SELECT * FROM gigs WHERE id=$1 AND status=$2', [req.params.id, 'active']);
    if (!gig.rows[0]) return res.status(404).json({ error: 'Gig not found' });

    const subtotalCents = Number(gig.rows[0].price_cents);
    const countryResult = await db.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]);
    const tax = calculateInternationalTax(subtotalCents, countryResult.rows[0]?.country || req.session.user.country);
    const amountCents = subtotalCents + tax.taxCents;
    await ensureWalletReady(req.session.user.id, amountCents);
    const feeCents = Math.round(amountCents * 0.05);
    const order = { id: nanoid(), gigId: req.params.id, buyerId: req.session.user.id, sellerId: gig.rows[0].seller_id, packageName: parsed.data.packageName, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO gig_orders (id,gig_id,buyer_id,seller_id,package_name,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.gigId, order.buyerId, order.sellerId, order.packageName, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]);
    await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'gig_purchase', order.amountCents, 'paid', { gigId: order.gigId, packageName: order.packageName, subtotalCents, taxCents: tax.taxCents, internationalTax: tax.isInternational, feeCents: order.feeCents }, new Date().toISOString()]);
    await updateTrustScoreOnSuccessfulTransaction(order.buyerId);
    res.status(201).json({ order, subtotalCents, taxCents: tax.taxCents, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents });
  } catch (error) {
    next(error);
  }
});

router.post('/api/gigs/:id/proposals', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ amountCents: z.number().int().positive(), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bid proposal' });

    const proposal = { id: nanoid(), gigId: req.params.id, buyerId: req.session.user.id, amountCents: parsed.data.amountCents, note: parsed.data.note || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO proposals (id,gig_id,buyer_id,amount_cents,note,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [proposal.id, proposal.gigId, proposal.buyerId, proposal.amountCents, proposal.note, 'pending', proposal.createdAt]);
    res.status(201).json({ proposal });
  } catch (error) {
    next(error);
  }
});

router.get('/api/listings', async (_req, res, next) => {
  try {
    const result = await db.query("SELECT id,seller_id AS \"sellerId\",title,type,category,price_cents AS \"priceCents\",media,status,created_at AS \"createdAt\" FROM listings WHERE status='active' ORDER BY created_at DESC");
    res.json({ listings: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/listings', requireUser, async (req, res, next) => {
  try {
    const mediaItem = z.object({ url: z.string().min(1), mimeType: z.string().min(1).max(100) });
    const parsed = z.object({ title: z.string().min(3).max(160), type: z.enum(['physical', 'digital', 'service', 'software']), category: z.string().max(120).optional(), priceCents: z.number().int().min(1).max(100000000), media: z.array(mediaItem).min(1).max(10) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid listing payload' });

    const listing = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO listings (id,seller_id,title,type,category,price_cents,media,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [listing.id, listing.sellerId, listing.title, listing.type, listing.category || null, listing.priceCents, JSON.stringify(listing.media), 'active', listing.createdAt]);
    res.status(201).json({ listing });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/admin/listings/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM listings WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Listing not found' });
    await db.query('DELETE FROM offers WHERE listing_id = $1', [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/api/checkout/commission-split', requireUser, (req, res) => {
  const parsed = z.object({ grossCents: z.number().int().positive(), creatorPercent: z.number().min(0).max(100), platformPercent: z.number().min(0).max(100) }).safeParse(req.body);
  if (!parsed.success || parsed.data.creatorPercent + parsed.data.platformPercent > 100) return res.status(400).json({ error: 'Invalid commission split' });
  const reservePercent = 100 - parsed.data.creatorPercent - parsed.data.platformPercent;
  res.json({ creatorCents: Math.round(parsed.data.grossCents * parsed.data.creatorPercent / 100), platformCents: Math.round(parsed.data.grossCents * parsed.data.platformPercent / 100), reserveCents: Math.round(parsed.data.grossCents * reservePercent / 100), reservePercent });
});

router.post('/api/reports', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ subject: z.string().min(2).max(120), reason: z.string().min(5).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid report payload' });

    const report = { id: nanoid(), userId: req.session.user.id, ...parsed.data, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO reports (id,user_id,subject,reason,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [report.id, report.userId, report.subject, report.reason, 'open', report.createdAt]);
    res.status(201).json({ report });
  } catch (error) {
    next(error);
  }
});


export default router;
