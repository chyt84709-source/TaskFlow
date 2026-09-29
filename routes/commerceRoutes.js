import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../utils/helpers.js';

const router = express.Router();

router.get('/api/categories', async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT child.id, child.name, child.parent_id AS "parentId", parent.name AS "parentName"
      FROM categories child LEFT JOIN categories parent ON parent.id = child.parent_id
      ORDER BY parent.name NULLS FIRST, child.name`);
    res.json({ categories: result.rows });
  } catch (error) {
    next(error);
  }
});

const storeFields = 'id,business_name AS "businessName",category,description,logo_url AS "logoUrl",cover_url AS "coverUrl",status,review_note AS "reviewNote",submitted_at AS "submittedAt",reviewed_at AS "reviewedAt"';
const storePayload = z.object({
  businessName: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(10).max(1500),
  logoUrl: z.string().max(500).refine((value) => value.startsWith('/api/media/') || /^https?:\/\//i.test(value), 'Invalid logo URL'),
  coverUrl: z.string().max(500).refine((value) => value.startsWith('/api/media/') || /^https?:\/\//i.test(value), 'Invalid cover URL'),
});

router.get('/api/store/me', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT ${storeFields} FROM stores WHERE owner_id=$1 ORDER BY submitted_at DESC`, [req.session.user.id]);
    res.json({ stores: result.rows, store: result.rows[0] || null });
  } catch (error) {
    next(error);
  }
});

router.get('/api/store/me/:id', requireUser, async (req, res, next) => {
  try {
    const storeResult = await db.query(`SELECT ${storeFields} FROM stores WHERE id=$1 AND owner_id=$2`, [req.params.id, req.session.user.id]);
    if (!storeResult.rows[0]) return res.status(404).json({ error: 'Store not found.' });
    const [products, sales, orders] = await Promise.all([
      db.query("SELECT id,title,description,category,price_cents AS \"priceCents\",stock,status,media,created_at AS \"createdAt\" FROM products WHERE store_id=$1 AND vendor_id=$2 AND status<>'removed' ORDER BY created_at DESC", [req.params.id, req.session.user.id]),
      db.query(`SELECT COUNT(*)::int AS "salesCount",COALESCE(SUM(o.quantity),0)::int AS "unitsSold",COALESCE(SUM(o.amount_cents),0)::int AS "salesCents"
        FROM product_orders o JOIN products p ON p.id=o.product_id
        WHERE p.store_id=$1 AND p.vendor_id=$2 AND o.seller_id=$2 AND o.status IN ('paid','processing','shipped','completed')`, [req.params.id, req.session.user.id]),
      db.query(`SELECT o.id,o.quantity,o.amount_cents AS "amountCents",o.status,o.created_at AS "createdAt",p.title AS "productTitle"
        FROM product_orders o JOIN products p ON p.id=o.product_id
        WHERE p.store_id=$1 AND p.vendor_id=$2 AND o.seller_id=$2 ORDER BY o.created_at DESC LIMIT 20`, [req.params.id, req.session.user.id])
    ]);
    res.json({ store: storeResult.rows[0], products: products.rows, sales: sales.rows[0], orders: orders.rows });
  } catch (error) {
    next(error);
  }
});

const submitStore = async (req, res, next) => {
  try {
    const parsed = storePayload.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a business name, store type, description, profile picture, and cover photo.' });
    const result = await db.query(`INSERT INTO stores (id,owner_id,business_name,category,description,logo_url,cover_url,status,submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',NOW()) RETURNING ${storeFields}`,
    [nanoid(), req.session.user.id, parsed.data.businessName, parsed.data.category, parsed.data.description, parsed.data.logoUrl, parsed.data.coverUrl]);
    res.status(201).json({ store: result.rows[0], submitted: true });
  } catch (error) {
    next(error);
  }
};

router.post('/api/store/me', requireUser, submitStore);
router.put('/api/store/me', requireUser, submitStore);

router.put('/api/store/me/:id', requireUser, async (req, res, next) => {
  try {
    const parsed = storePayload.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a business name, store type, description, profile picture, and cover photo.' });
    const result = await db.query(`UPDATE stores SET business_name=$1,category=$2,description=$3,logo_url=$4,cover_url=$5,status='pending',review_note=NULL,submitted_at=NOW(),reviewed_at=NULL,reviewed_by=NULL
      WHERE id=$6 AND owner_id=$7 AND status<>'verified' RETURNING ${storeFields}`,
    [parsed.data.businessName, parsed.data.category, parsed.data.description, parsed.data.logoUrl, parsed.data.coverUrl, req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(409).json({ error: 'This store cannot be edited or is no longer available.' });
    res.json({ store: result.rows[0], submitted: true });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/store/me/:id/media', requireUser, async (req, res, next) => {
  try {
    const imageUrl = z.string().max(500).refine((value) => value.startsWith('/api/media/') || /^https?:\/\//i.test(value), 'Invalid image URL');
    const parsed = z.object({ logoUrl: imageUrl.optional(), coverUrl: imageUrl.optional() }).refine((value) => value.logoUrl || value.coverUrl).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose a new store profile picture or cover photo.' });
    const result = await db.query(`UPDATE stores SET logo_url=COALESCE($1,logo_url),cover_url=COALESCE($2,cover_url)
      WHERE id=$3 AND owner_id=$4 RETURNING ${storeFields}`,
    [parsed.data.logoUrl || null, parsed.data.coverUrl || null, req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Store not found.' });
    res.json({ store: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/store-requests', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT s.id,s.owner_id AS "ownerId",s.business_name AS "businessName",s.category,s.description,s.logo_url AS "logoUrl",s.cover_url AS "coverUrl",s.status,s.review_note AS "reviewNote",s.submitted_at AS "submittedAt",u.name AS "ownerName",u.email AS "ownerEmail"
      FROM stores s LEFT JOIN users u ON u.id=s.owner_id ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,s.submitted_at`);
    res.json({ requests: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/admin/store-requests/:id/review', requireAdmin, async (req, res, next) => {
  const parsed = z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().trim().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a valid review decision.' });
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const store = await client.query(`UPDATE stores SET status=$1,review_note=$2,reviewed_at=NOW(),reviewed_by=$3
      WHERE id=$4 RETURNING owner_id AS "ownerId",business_name AS "businessName"`, [parsed.data.decision, parsed.data.note || null, req.session.user.id, req.params.id]);
    if (!store.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Store request not found.' });
    }
    const text = parsed.data.decision === 'verified'
      ? `Your store, ${store.rows[0].businessName}, is verified and ready to use.`
      : `Your store request needs changes: ${parsed.data.note || 'Please review your store details and submit again.'}`;
    await client.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [nanoid(), store.rows[0].ownerId, 'store-review', text]);
    await client.query('COMMIT');
    res.json({ reviewed: true, status: parsed.data.decision });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

router.get('/api/products', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    let query = `SELECT p.*, COALESCE(AVG(r.rating), 0)::float AS avg_rating, COUNT(r.id)::int AS review_count,s.business_name AS store_name,s.logo_url AS store_logo_url,s.cover_url AS store_cover_url,u.subscription_tier AS store_tier,u.green_tick AS store_green_tick FROM products p LEFT JOIN reviews r ON r.product_id = p.id LEFT JOIN stores s ON s.id=p.store_id LEFT JOIN users u ON u.id=p.vendor_id WHERE p.status = 'active'`;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (LOWER(p.title) LIKE LOWER($${params.length}) OR LOWER(p.description) LIKE LOWER($${params.length}))`;
    }
    if (category) {
      params.push(category);
      query += ' AND';
      query += ` p.category = $${params.length}`;
    }
    query += ' GROUP BY p.id,s.business_name,s.logo_url,s.cover_url,u.subscription_tier,u.green_tick ORDER BY p.created_at DESC';

    const result = await db.query(query, params);
    res.json({ products: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/products', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), stock: z.number().int().min(0).default(1), media: z.array(z.string().min(1)).default([]), storeId: z.string().min(1).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload' });

    if (parsed.data.storeId) {
      const store = await db.query("SELECT id FROM stores WHERE id=$1 AND owner_id=$2 AND status='verified'", [parsed.data.storeId, req.session.user.id]);
      if (!store.rows[0]) return res.status(400).json({ error: 'Choose one of your approved stores.' });
    }
    const priceCents = Number(parsed.data.priceCents ?? Math.round((parsed.data.priceDollars || 0) * 100));
    const product = { id: nanoid(), vendorId: req.session.user.id, storeId: parsed.data.storeId || null, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category, priceCents, stock: parsed.data.stock, media: parsed.data.media, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO products (id,vendor_id,store_id,title,description,category,price_cents,stock,media,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [product.id, product.vendorId, product.storeId, product.title, product.description, product.category, product.priceCents, product.stock, JSON.stringify(product.media), 'active', product.createdAt]);
    res.status(201).json({ product });
  } catch (error) {
    next(error);
  }
});

router.get('/api/promotions/requests/mine', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT r.id,r.product_id AS "productId",p.title AS "productTitle",r.requested_days AS "requestedDays",r.offered_days AS "offeredDays",r.price_cents AS "priceCents",r.admin_reply AS "adminReply",r.status,r.created_at AS "createdAt"
      FROM promotion_requests r JOIN products p ON p.id=r.product_id
      WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [req.session.user.id]);
    res.json({ requests: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/promotions/requests', requireUser, async (req, res, next) => {
  const parsed = z.object({ productId: z.string().min(1), requestedDays: z.number().int().min(1).max(30).default(7) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a product and a feature period from 1 to 30 days.' });
  try {
    const account = await db.query('SELECT subscription_tier FROM users WHERE id=$1', [req.session.user.id]);
    if (account.rows[0]?.subscription_tier !== 'premium') return res.status(403).json({ error: 'Premium membership is required before requesting product promotion.' });
    const productResult = await db.query("SELECT id,title,media FROM products WHERE id=$1 AND vendor_id=$2 AND status='active'", [parsed.data.productId, req.session.user.id]);
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ error: 'Choose one of your active products.' });
    if (!Array.isArray(product.media) || !product.media.length) return res.status(400).json({ error: 'Add a product photo before requesting homepage promotion.' });
    const existing = await db.query("SELECT id,status FROM promotion_requests WHERE user_id=$1 AND product_id=$2 AND status IN ('pending','quoted') ORDER BY created_at DESC LIMIT 1", [req.session.user.id, product.id]);
    if (existing.rows[0]) return res.status(409).json({ error: 'A promotion request for this product is already being reviewed.' });
    const request = { id: nanoid(), userId: req.session.user.id, productId: product.id, requestedDays: parsed.data.requestedDays };
    await db.query('INSERT INTO promotion_requests (id,user_id,product_id,requested_days,status,created_at) VALUES ($1,$2,$3,$4,$5,NOW())', [request.id, request.userId, request.productId, request.requestedDays, 'pending']);
    res.status(201).json({ request: { ...request, productTitle: product.title, status: 'pending' } });
  } catch (error) {
    next(error);
  }
});

router.get('/api/vendor/inventory', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT id,title,category,price_cents AS "priceCents",stock,status,media,created_at AS "createdAt"
      FROM products WHERE vendor_id=$1 ORDER BY created_at DESC`, [req.session.user.id]);
    res.json({ products: result.rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/vendor/products/:id/stock', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ stock: z.number().int().min(0).max(1000000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a stock quantity from 0 to 1,000,000.' });
    const result = await db.query('UPDATE products SET stock=$1 WHERE id=$2 AND vendor_id=$3 RETURNING id,stock', [parsed.data.stock, req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Your product was not found.' });
    res.json({ updated: true, product: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/vendor/products/:id', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      title: z.string().trim().min(3).max(120),
      description: z.string().trim().min(5).max(2000),
      category: z.string().trim().min(2).max(60),
      priceCents: z.number().int().positive(),
      stock: z.number().int().min(0).max(1000000),
      media: z.array(z.string().min(1)).max(10).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter valid product details.' });
    const result = await db.query(`UPDATE products SET title=$1,description=$2,category=$3,price_cents=$4,stock=$5,media=COALESCE($6::jsonb,media)
      WHERE id=$7 AND vendor_id=$8 AND status='active'
      RETURNING id,title,description,category,price_cents AS "priceCents",stock,media,status`,
    [parsed.data.title, parsed.data.description, parsed.data.category, parsed.data.priceCents, parsed.data.stock, parsed.data.media ? JSON.stringify(parsed.data.media) : null, req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Active product not found for this account.' });
    res.json({ product: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/vendor/products/:id', requireUser, async (req, res, next) => {
  try {
    const result = await db.query("UPDATE products SET status='removed' WHERE id=$1 AND vendor_id=$2 AND status='active' RETURNING id", [req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Active product not found for this account.' });
    res.json({ removed: true, productId: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

router.get('/api/vendor/orders', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT o.id,o.product_id AS "productId",o.buyer_id AS "buyerId",o.quantity,o.amount_cents AS "amountCents",o.status,o.notes,o.created_at AS "createdAt",p.title AS "productTitle",u.name AS "buyerName",u.email AS "buyerEmail"
      FROM product_orders o JOIN products p ON p.id=o.product_id LEFT JOIN users u ON u.id=o.buyer_id
      WHERE o.seller_id=$1 ORDER BY o.created_at DESC`, [req.session.user.id]);
    res.json({ orders: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/vendor/orders/:id/status', requireUser, async (req, res, next) => {
  const parsed = z.object({ status: z.enum(['processing', 'shipped', 'completed']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a valid order status.' });
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const order = await client.query('SELECT id,buyer_id AS "buyerId",status FROM product_orders WHERE id=$1 AND seller_id=$2 FOR UPDATE', [req.params.id, req.session.user.id]);
    if (!order.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found for this store.' });
    }
    const nextStatus = { paid: 'processing', processing: 'shipped', shipped: 'completed' }[order.rows[0].status];
    if (parsed.data.status !== nextStatus) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This order must move to ${nextStatus || 'a terminal state'} next.` });
    }
    await client.query('UPDATE product_orders SET status=$1 WHERE id=$2', [parsed.data.status, req.params.id]);
    await client.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [nanoid(), order.rows[0].buyerId, 'order', `Your order ${req.params.id} is now ${parsed.data.status}.`]);
    await client.query('COMMIT');
    res.json({ updated: true, status: parsed.data.status });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

router.delete('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Product not found' });
    await Promise.all([
      db.query('DELETE FROM cart_items WHERE product_id = $1', [req.params.id]),
      db.query('DELETE FROM reviews WHERE product_id = $1', [req.params.id]),
    ]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/content', requireAdmin, async (_req, res, next) => {
  try {
    const [products, listings, gigs, tasks, media] = await Promise.all([
      db.query('SELECT p.*, u.name AS owner_name, u.email AS owner_email FROM products p LEFT JOIN users u ON u.id = p.vendor_id ORDER BY p.created_at DESC'),
      db.query('SELECT l.*, u.name AS owner_name, u.email AS owner_email FROM listings l LEFT JOIN users u ON u.id = l.seller_id ORDER BY l.created_at DESC'),
      db.query('SELECT g.*, u.name AS owner_name, u.email AS owner_email FROM gigs g LEFT JOIN users u ON u.id = g.seller_id ORDER BY g.created_at DESC'),
      db.query('SELECT t.*, u.name AS owner_name, u.email AS owner_email FROM tasks t LEFT JOIN users u ON u.id = t.client_id ORDER BY t.created_at DESC'),
      db.query(`SELECT m.id,m.user_id AS "userId",m.filename,m.mime_type AS "mimeType",m.purpose,m.created_at AS "createdAt",u.name AS "userName",u.email AS "userEmail",'/api/media/' || m.id AS url FROM media_files m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.created_at DESC`),
    ]);
    res.json({ products: products.rows, listings: listings.rows, gigs: gigs.rows, tasks: tasks.rows, media: media.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/promotion-requests', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT r.id,r.user_id AS "userId",r.product_id AS "productId",r.requested_days AS "requestedDays",r.offered_days AS "offeredDays",r.price_cents AS "priceCents",r.admin_reply AS "adminReply",r.status,r.created_at AS "createdAt",r.reviewed_at AS "reviewedAt",p.title AS "productTitle",p.description AS "productDescription",p.category,p.price_cents AS "productPriceCents",p.media,u.name AS "userName",u.email AS "userEmail"
      FROM promotion_requests r JOIN products p ON p.id=r.product_id LEFT JOIN users u ON u.id=r.user_id
      ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'quoted' THEN 1 ELSE 2 END,r.created_at DESC`);
    res.json({ requests: result.rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/admin/promotion-requests/:id/review', requireAdmin, async (req, res, next) => {
  const parsed = z.object({
    decision: z.enum(['approved', 'rejected']),
    offeredDays: z.number().int().min(1).max(30),
    priceCents: z.number().int().min(0).max(100000000),
    reply: z.string().trim().min(3).max(1000),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a reply, valid feature duration, and price.' });
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const requestResult = await client.query(`SELECT r.id,r.user_id AS "userId",r.product_id AS "productId",r.status,p.title,p.description,p.category,p.media
      FROM promotion_requests r JOIN products p ON p.id=r.product_id WHERE r.id=$1 FOR UPDATE OF r`, [req.params.id]);
    const request = requestResult.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Promotion request not found.' });
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This promotion request has already been reviewed.' });
    }
    let status = parsed.data.decision === 'rejected' ? 'rejected' : parsed.data.priceCents > 0 ? 'quoted' : 'approved';
    let adId = null;
    if (status === 'approved') {
      const mediaEntry = Array.isArray(request.media) ? request.media[0] : null;
      const mediaUrl = typeof mediaEntry === 'string' ? mediaEntry : mediaEntry?.url;
      if (!mediaUrl) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The product no longer has a promotion image.' });
      }
      const mediaId = mediaUrl.match(/^\/api\/media\/([^/?#]+)/)?.[1];
      const mimeResult = mediaId ? await client.query('SELECT mime_type FROM media_files WHERE id=$1', [mediaId]) : { rows: [] };
      const mimeType = mimeResult.rows[0]?.mime_type || mediaEntry?.mimeType || 'image/webp';
      adId = nanoid();
      await client.query(`INSERT INTO ads (id,seller_id,title,description,category,price_cents,location,media,status,placement,duration_days,skip_allowed,created_at)
        VALUES ($1,$2,$3,$4,$5,1,'homepage',$6,'active','premium-product',$7,TRUE,NOW())`, [adId, request.userId, request.title, request.description || '', request.category || 'Product', JSON.stringify([{ url: mediaUrl, mimeType }]), parsed.data.offeredDays]);
    }
    await client.query(`UPDATE promotion_requests SET status=$1,offered_days=$2,price_cents=$3,admin_reply=$4,ad_id=$5,reviewed_by=$6,reviewed_at=NOW() WHERE id=$7`, [status, parsed.data.offeredDays, parsed.data.priceCents, parsed.data.reply, adId, req.session.user.id, request.id]);
    const notice = status === 'approved'
      ? `Your product feature was approved for ${parsed.data.offeredDays} days. ${parsed.data.reply}`
      : status === 'quoted'
        ? `A promotion quote is ready: ${parsed.data.offeredDays} days for ${moneyText(parsed.data.priceCents)}. ${parsed.data.reply}`
        : `Your product feature request was declined. ${parsed.data.reply}`;
    await client.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [nanoid(), request.userId, 'promotion-review', notice]);
    await client.query('COMMIT');
    res.json({ reviewed: true, status, adId });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

function moneyText(amountCents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountCents / 100);
}

router.get('/api/support/threads', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT t.id,t.subject,t.status,t.created_at AS "createdAt",t.updated_at AS "updatedAt",
        (SELECT body FROM support_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
      FROM support_threads t WHERE t.user_id = $1 ORDER BY t.updated_at DESC`, [req.session.user.id]);
    res.json({ threads: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/support/threads', requireUser, async (req, res, next) => {
  const parsed = z.object({ subject: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a subject and message.' });
  let client;
  try {
    client = await db.connect();
    const threadId = nanoid();
    await client.query('BEGIN');
    await client.query('INSERT INTO support_threads (id,user_id,subject,status,created_at,updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())', [threadId, req.session.user.id, parsed.data.subject, 'open']);
    const message = { id: nanoid(), threadId, senderId: req.session.user.id, body: parsed.data.body };
    await client.query('INSERT INTO support_messages (id,thread_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [message.id, threadId, message.senderId, message.body]);
    await client.query('COMMIT');
    res.status(201).json({ thread: { id: threadId, subject: parsed.data.subject, status: 'open' }, message });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

router.get('/api/support/threads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const thread = await db.query('SELECT id FROM support_threads WHERE id=$1 AND user_id=$2', [req.params.id, req.session.user.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Support conversation not found.' });
    const result = await db.query(`SELECT m.id,m.sender_id AS "senderId",m.body,m.created_at AS "createdAt",u.name AS "senderName",u.role AS "senderRole"
      FROM support_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at`, [req.params.id]);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/support/threads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a message.' });
    const thread = await db.query("SELECT id FROM support_threads WHERE id=$1 AND user_id=$2 AND status='open'", [req.params.id, req.session.user.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Open support conversation not found.' });
    const message = { id: nanoid(), threadId: req.params.id, senderId: req.session.user.id, body: parsed.data.body };
    await db.query('INSERT INTO support_messages (id,thread_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [message.id, message.threadId, message.senderId, message.body]);
    await db.query('UPDATE support_threads SET updated_at=NOW() WHERE id=$1', [message.threadId]);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/support/threads', requireAdmin, async (_req, res, next) => {
  try {
    const result = await db.query(`SELECT t.id,t.user_id AS "userId",t.subject,t.status,t.created_at AS "createdAt",t.updated_at AS "updatedAt",u.name AS "userName",u.email AS "userEmail",
        (SELECT body FROM support_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
      FROM support_threads t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC`);
    res.json({ threads: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/admin/support/threads/:id/messages', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT m.id,m.sender_id AS "senderId",m.body,m.created_at AS "createdAt",u.name AS "senderName",u.role AS "senderRole"
      FROM support_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at`, [req.params.id]);
    if (!result.rows.length) {
      const thread = await db.query('SELECT id FROM support_threads WHERE id=$1', [req.params.id]);
      if (!thread.rows[0]) return res.status(404).json({ error: 'Support conversation not found.' });
    }
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/admin/support/threads/:id/messages', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a message.' });
    const thread = await db.query("SELECT id FROM support_threads WHERE id=$1 AND status='open'", [req.params.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Open support conversation not found.' });
    const message = { id: nanoid(), threadId: req.params.id, senderId: req.session.user.id, body: parsed.data.body };
    await db.query('INSERT INTO support_messages (id,thread_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,NOW())', [message.id, message.threadId, message.senderId, message.body]);
    await db.query('UPDATE support_threads SET updated_at=NOW() WHERE id=$1', [message.threadId]);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.post('/api/products/:id/purchase', requireUser, async (req, res, next) => {
  let client;
  try {
    const parsed = z.object({ quantity: z.number().int().min(1).max(50).default(1), notes: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid purchase details are required' });

    const productResult = await db.query("SELECT * FROM products WHERE id=$1 AND status='active'", [req.params.id]);
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const quantity = parsed.data.quantity;
    if (Number(product.stock) < quantity) return res.status(409).json({ error: 'Not enough stock is available.' });

    const subtotalCents = Number(product.price_cents) * quantity;
    const countryResult = await db.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]);
    const tax = calculateInternationalTax(subtotalCents, countryResult.rows[0]?.country || req.session.user.country);
    const amountCents = subtotalCents + tax.taxCents;
    await ensureWalletReady(req.session.user.id, amountCents);
    const feeCents = Math.round(amountCents * 0.01);
    const order = { id: nanoid(), productId: req.params.id, buyerId: req.session.user.id, sellerId: product.vendor_id, quantity, amountCents, feeCents, notes: parsed.data.notes || null, createdAt: new Date().toISOString() };

    client = await db.connect();
    await client.query('BEGIN');
    const stockUpdate = await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2 AND status='active' AND stock >= $1 RETURNING id", [quantity, order.productId]);
    if (!stockUpdate.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not enough stock is available.' });
    }
    await client.query('INSERT INTO product_orders (id,product_id,buyer_id,seller_id,quantity,amount_cents,fee_cents,status,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [order.id, order.productId, order.buyerId, order.sellerId, order.quantity, order.amountCents, order.feeCents, 'paid', order.notes, order.createdAt]);
    await client.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), order.buyerId, 'product_purchase', order.amountCents, 'paid', { productId: order.productId, quantity, subtotalCents, taxCents: tax.taxCents, internationalTax: tax.isInternational, feeCents: order.feeCents }, order.createdAt]);
    await client.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), order.sellerId, 'order', `New order for ${quantity} × ${product.title}.`, order.createdAt]);
    await client.query('COMMIT');
    await updateTrustScoreOnSuccessfulTransaction(order.buyerId).catch((error) => console.error('Trust score update failed after product order:', error));
    res.status(201).json({ order, subtotalCents, taxCents: tax.taxCents, totalCents: order.amountCents, feeCents: order.feeCents, netCents: order.amountCents - order.feeCents });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client?.release();
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
    const countryResult = await db.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]);
    const tax = calculateInternationalTax(subtotalCents, countryResult.rows[0]?.country || req.session.user.country);
    const feeCents = Math.round(subtotalCents * 0.05);
    const totalCents = subtotalCents + feeCents + tax.taxCents;
    await ensureWalletReady(req.session.user.id, totalCents);
    await db.query('INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [nanoid(), req.session.user.id, 'marketplace_purchase', totalCents, 'paid', { feeCents, subtotalCents, taxCents: tax.taxCents, internationalTax: tax.isInternational, source: 'cart' }, new Date().toISOString()]);
    await db.query('DELETE FROM cart_items WHERE user_id=$1', [req.session.user.id]);
    res.json({ subtotalCents, feeCents, taxCents: tax.taxCents, totalCents, platformFeePercent: 5 });
  } catch (error) {
    next(error);
  }
});

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
