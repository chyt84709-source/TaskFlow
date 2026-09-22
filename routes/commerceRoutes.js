import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db, normalizeCountry } from '../config/database.js';
import { requireUser } from '../utils/helpers.js';

const router = express.Router();

router.get('/api/products', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    let query = `SELECT p.*, COALESCE(AVG(r.rating), 0)::float AS avg_rating, COUNT(r.id)::int AS review_count FROM products p LEFT JOIN reviews r ON r.product_id = p.id`;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` WHERE LOWER(p.title) LIKE LOWER($${params.length}) OR LOWER(p.description) LIKE LOWER($${params.length})`;
    }
    if (category) {
      params.push(category);
      query += params.length === 1 ? ' WHERE' : ' AND';
      query += ` p.category = $${params.length}`;
    }
    query += ' GROUP BY p.id ORDER BY p.created_at DESC';

    const result = await db.query(query, params);
    res.json({ products: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/products', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), stock: z.number().int().min(0).default(1), media: z.array(z.string().min(1)).default([]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload' });

    const priceCents = Number(parsed.data.priceCents ?? Math.round((parsed.data.priceDollars || 0) * 100));
    const product = { id: nanoid(), vendorId: req.session.user.id, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, priceCents, stock: parsed.data.stock, media: parsed.data.media, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO products (id,vendor_id,title,description,category,price_cents,stock,media,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [product.id, product.vendorId, product.title, product.description, product.category, product.priceCents, product.stock, JSON.stringify(product.media), product.createdAt]);
    res.status(201).json({ product });
  } catch (error) {
    next(error);
  }
});

router.post('/api/products/:id/purchase', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ quantity: z.number().int().min(1).max(50).default(1), notes: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid purchase details are required' });

    const product = await db.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!product.rows[0]) return res.status(404).json({ error: 'Product not found' });

    const quantity = parsed.data.quantity;
    const amountCents = Number(product.rows[0].price_cents) * quantity;
    const feeCents = Math.round(amountCents * 0.01);
    const order = { id: nanoid(), productId: req.params.id, buyerId: req.session.user.id, sellerId: product.rows[0].vendor_id, quantity, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO product_orders (id,product_id,buyer_id,seller_id,quantity,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.productId, order.buyerId, order.sellerId, order.quantity, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]);
    await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'product_purchase', order.amountCents, 'paid', { productId: order.productId, quantity, feeCents: order.feeCents }, new Date().toISOString()]);
    res.status(201).json({ order, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents });
  } catch (error) {
    next(error);
  }
});

router.post('/api/products/:id/reviews', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid review required' });

    const review = { id: nanoid(), productId: req.params.id, userId: req.session.user.id, ...parsed.data, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO reviews (id,product_id,user_id,rating,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (product_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment', [review.id, review.productId, review.userId, review.rating, review.comment || null, review.createdAt]);
    res.status(201).json({ review });
  } catch (error) {
    next(error);
  }
});

router.get('/api/cart', requireUser, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT ci.id, ci.product_id AS "productId", ci.quantity, p.title, p.price_cents AS "priceCents", p.category, p.media FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = $1 ORDER BY ci.created_at DESC`, [_req.session.user.id]);
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/cart', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(20).default(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid cart item' });

    await db.query('INSERT INTO cart_items (id,user_id,product_id,quantity,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity', [nanoid(), req.session.user.id, parsed.data.productId, parsed.data.quantity, new Date().toISOString()]);
    res.status(201).json({ ok: true, quantity: parsed.data.quantity });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/cart/:productId', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.session.user.id, req.params.productId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Cart item not found' });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/api/checkout/cart', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT ci.quantity, p.price_cents AS "priceCents" FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = $1`, [req.session.user.id]);
    const subtotalCents = result.rows.reduce((sum, row) => sum + row.quantity * row.priceCents, 0);
    const feeCents = Math.round(subtotalCents * 0.05);
    const totalCents = subtotalCents + feeCents;
    await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), req.session.user.id, 'marketplace_purchase', totalCents, 'paid', { feeCents, subtotalCents, source: 'cart' }, new Date().toISOString()]);
    await db.query('DELETE FROM cart_items WHERE user_id=$1', [req.session.user.id]);
    res.json({ subtotalCents, feeCents, totalCents, platformFeePercent: 5 });
  } catch (error) {
    next(error);
  }
});

router.get('/api/ads', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM ads ORDER BY created_at DESC');
    res.json({ ads: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/ads', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.string().min(2).max(60), location: z.string().min(2).max(120), priceCents: z.number().int().positive(), placement: z.string().min(2).max(80).default('homepage-top'), durationDays: z.number().int().min(1).max(365).default(7), skipAllowed: z.boolean().default(true), media: z.array(z.string().url()).default([]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid ad payload' });

    const ad = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, media: parsed.data.media, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO ads (id,seller_id,title,description,category,price_cents,location,media,status,placement,duration_days,skip_allowed,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [ad.id, ad.sellerId, ad.title, ad.description, ad.category, ad.priceCents, ad.location, JSON.stringify(ad.media), 'active', ad.placement, ad.durationDays, ad.skipAllowed, ad.createdAt]);
    res.status(201).json({ ad });
  } catch (error) {
    next(error);
  }
});

router.get('/api/ads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM ad_messages WHERE ad_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/ads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Message required' });

    const message = { id: nanoid(), adId: req.params.id, senderId: req.session.user.id, body: parsed.data.body, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO ad_messages (id,ad_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, message.adId, message.senderId, message.body, message.createdAt]);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.get('/api/gigs', async (_req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM gigs ORDER BY created_at DESC');
    res.json({ gigs: result.rows });
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
    await db.query('INSERT INTO gigs (id,seller_id,title,description,category,price_cents,delivery_days,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [gig.id, gig.sellerId, gig.title, gig.description, gig.category, gig.priceCents, gig.deliveryDays, 'active', gig.createdAt]);
    res.status(201).json({ gig });
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

    const amountCents = Number(gig.rows[0].price_cents);
    const feeCents = Math.round(amountCents * 0.05);
    const order = { id: nanoid(), gigId: req.params.id, buyerId: req.session.user.id, sellerId: gig.rows[0].seller_id, packageName: parsed.data.packageName, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO gig_orders (id,gig_id,buyer_id,seller_id,package_name,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.gigId, order.buyerId, order.sellerId, order.packageName, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]);
    await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'gig_purchase', order.amountCents, 'paid', { gigId: order.gigId, packageName: order.packageName, feeCents: order.feeCents }, new Date().toISOString()]);
    res.status(201).json({ order, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents });
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
    const result = await db.query("SELECT id,title,type,price_cents AS \"priceCents\",status,created_at AS \"createdAt\" FROM listings WHERE status='active' ORDER BY created_at DESC");
    res.json({ listings: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/listings', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().min(3).max(160), type: z.enum(['physical', 'digital', 'service', 'software']), priceCents: z.number().int().min(1).max(100000000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid listing payload' });

    const listing = { id: nanoid(), sellerId: req.session.user.id, ...parsed.data, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO listings (id,seller_id,title,type,price_cents,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [listing.id, listing.sellerId, listing.title, listing.type, listing.priceCents, 'active', listing.createdAt]);
    res.status(201).json({ listing });
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
