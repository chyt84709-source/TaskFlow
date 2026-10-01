import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

const router = express.Router();
const productMediaSchema = z.union([
  z.string().min(1),
  z.object({ url: z.string().min(1), mimeType: z.string().min(1).max(100) }),
]);

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
    const parsed = z.object({ title: z.string().min(3).max(120), description: z.string().min(5).max(2000), category: z.string().min(2).max(60), priceCents: z.number().int().positive().optional(), priceDollars: z.number().min(0.01).max(1000000).optional(), stock: z.number().int().min(0).default(1), media: z.array(productMediaSchema).min(1).max(10), storeId: z.string().min(1).optional() }).safeParse(req.body);
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
      media: z.array(productMediaSchema).min(1).max(10).optional()
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


export default router;
