import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

const router = express.Router();

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


export default router;
