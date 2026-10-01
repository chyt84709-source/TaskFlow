import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

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
    const [products, sales, orders, inventory, monthlyActivity] = await Promise.all([
      db.query("SELECT id,title,description,category,price_cents AS \"priceCents\",stock,status,media,created_at AS \"createdAt\" FROM products WHERE store_id=$1 AND vendor_id=$2 AND status<>'removed' ORDER BY created_at DESC", [req.params.id, req.session.user.id]),
      db.query(`SELECT COUNT(*)::int AS "salesCount",COALESCE(SUM(o.quantity),0)::int AS "unitsSold",COALESCE(SUM(o.amount_cents),0)::int AS "salesCents"
        FROM product_orders o JOIN products p ON p.id=o.product_id
        WHERE p.store_id=$1 AND p.vendor_id=$2 AND o.seller_id=$2 AND o.status IN ('paid','processing','shipped','completed')`, [req.params.id, req.session.user.id]),
      db.query(`SELECT o.id,o.quantity,o.amount_cents AS "amountCents",o.status,o.created_at AS "createdAt",p.title AS "productTitle"
        FROM product_orders o JOIN products p ON p.id=o.product_id
        WHERE p.store_id=$1 AND p.vendor_id=$2 AND o.seller_id=$2 ORDER BY o.created_at DESC LIMIT 20`, [req.params.id, req.session.user.id]),
      db.query(`SELECT COUNT(*) FILTER (WHERE status<>'removed')::int AS "productCount",
          COALESCE(SUM(stock) FILTER (WHERE status='active'),0)::int AS "unitsInStock",
          COALESCE(SUM(stock::bigint * price_cents::bigint) FILTER (WHERE status='active'),0)::bigint AS "inventoryValueCents"
        FROM products WHERE store_id=$1 AND vendor_id=$2`, [req.params.id, req.session.user.id]),
      db.query(`SELECT COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS "ordersThisMonth",
          COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND status IN ('paid','processing','shipped','completed')),0)::bigint AS "revenueThisMonthCents"
        FROM product_orders WHERE seller_id=$1 AND product_id IN (SELECT id FROM products WHERE store_id=$2 AND vendor_id=$1)`, [req.session.user.id, req.params.id])
    ]);
    res.json({ store: storeResult.rows[0], products: products.rows, sales: sales.rows[0], orders: orders.rows, inventory: inventory.rows[0], monthlyActivity: monthlyActivity.rows[0] });
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


export default router;
