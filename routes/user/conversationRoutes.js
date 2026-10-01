import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../../config/database.js';
import { requireUser } from '../../utils/helpers.js';

const router = express.Router();

router.get('/api/offers', requireUser, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM offers WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC', [req.session.user.id]);
    res.json({ offers: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content-offers', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      contentType: z.enum(['task', 'product', 'gig', 'listing']),
      contentId: z.string().min(1),
      amountCents: z.number().int().positive(),
      message: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose an item and enter a valid offer amount.' });

    const tableMap = {
      task: ['tasks', 'client_id'],
      product: ['products', 'vendor_id'],
      gig: ['gigs', 'seller_id'],
      listing: ['listings', 'seller_id'],
    };
    const [table, ownerColumn] = tableMap[parsed.data.contentType];
    const item = await db.query(`SELECT id, ${ownerColumn} AS owner_id FROM ${table} WHERE id = $1${parsed.data.contentType === 'task' || parsed.data.contentType === 'gig' || parsed.data.contentType === 'listing' ? " AND status = 'active'" : ''}`, [parsed.data.contentId]);
    const sellerId = item.rows[0]?.owner_id;
    if (!sellerId) return res.status(404).json({ error: 'This item is no longer available.' });
    if (sellerId === req.session.user.id) return res.status(400).json({ error: 'You cannot make an offer on your own item.' });

    const conversationId = nanoid();
    const offerId = nanoid();
    await db.query('INSERT INTO conversations (id,content_type,content_id,buyer_id,seller_id,offer_id,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [conversationId, parsed.data.contentType, parsed.data.contentId, req.session.user.id, sellerId, offerId, 'pending', new Date().toISOString()]);
    await db.query('INSERT INTO content_offers (id,content_type,content_id,buyer_id,seller_id,amount_cents,message,status,conversation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [offerId, parsed.data.contentType, parsed.data.contentId, req.session.user.id, sellerId, parsed.data.amountCents, parsed.data.message || null, 'pending', conversationId, new Date().toISOString()]);
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), sellerId, 'offer', `You received a new offer of ${(parsed.data.amountCents / 100).toFixed(2)} for your ${parsed.data.contentType}.`, new Date().toISOString()]);
    res.status(201).json({ offer: { id: offerId, conversationId, status: 'pending' } });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content/:contentType/:id/status', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(['active', 'sold']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid item status.' });
    const tableMap = { task: ['tasks', 'client_id'], product: ['products', 'vendor_id'], gig: ['gigs', 'seller_id'], listing: ['listings', 'seller_id'] };
    const [table, ownerColumn] = tableMap[req.params.contentType] || [];
    if (!table) return res.status(400).json({ error: 'Unsupported content type.' });
    const result = await db.query(`UPDATE ${table} SET status = $1 WHERE id = $2 AND ${ownerColumn} = $3`, [parsed.data.status, req.params.id, req.session.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Item not found or you are not the owner.' });
    res.json({ ok: true, status: parsed.data.status });
  } catch (error) {
    next(error);
  }
});

router.get('/api/content-offers', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT o.*, c.status AS conversation_status, u.name AS buyer_name, s.name AS seller_name
      FROM content_offers o
      JOIN conversations c ON c.id = o.conversation_id
      LEFT JOIN users u ON u.id = o.buyer_id
      LEFT JOIN users s ON s.id = o.seller_id
      WHERE o.buyer_id = $1 OR o.seller_id = $1 ORDER BY o.created_at DESC`, [req.session.user.id]);
    res.json({ offers: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/content-offers/:id/respond', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ decision: z.enum(['accepted', 'rejected']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose accept or reject.' });
    const offer = await db.query('SELECT * FROM content_offers WHERE id = $1 AND seller_id = $2', [req.params.id, req.session.user.id]);
    if (!offer.rows[0]) return res.status(404).json({ error: 'Offer not found.' });
    const row = offer.rows[0];
    await db.query('UPDATE content_offers SET status = $1, responded_at = $2 WHERE id = $3', [parsed.data.decision, new Date().toISOString(), row.id]);
    await db.query('UPDATE conversations SET status = $1 WHERE id = $2', [parsed.data.decision === 'accepted' ? 'open' : 'rejected', row.conversation_id]);
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), row.buyer_id, 'offer', `Your offer was ${parsed.data.decision}.`, new Date().toISOString()]);
    res.json({ ok: true, status: parsed.data.decision, conversationId: row.conversation_id });
  } catch (error) {
    next(error);
  }
});

router.get('/api/conversations', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`SELECT c.*, o.amount_cents, o.status AS offer_status, u.name AS buyer_name, s.name AS seller_name
      FROM conversations c JOIN content_offers o ON o.id = c.offer_id
      LEFT JOIN users u ON u.id = c.buyer_id LEFT JOIN users s ON s.id = c.seller_id
      WHERE c.buyer_id = $1 OR c.seller_id = $1 ORDER BY c.created_at DESC`, [req.session.user.id]);
    res.json({ conversations: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/conversations/:id/messages', requireUser, async (req, res, next) => {
  try {
    const access = await db.query('SELECT id FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [req.params.id, req.session.user.id]);
    if (!access.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
    const result = await db.query('SELECT m.*, u.name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 ORDER BY m.created_at ASC', [req.params.id]);
    res.json({ messages: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/conversations/:id/messages', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ body: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Message cannot be empty.' });
    const access = await db.query('SELECT buyer_id, seller_id, status FROM conversations WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)', [req.params.id, req.session.user.id]);
    const conversation = access.rows[0];
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    if (conversation.status !== 'open') return res.status(409).json({ error: 'Accept the offer before starting the chat.' });
    const message = { id: nanoid(), threadId: req.params.id, senderId: req.session.user.id, body: parsed.data.body, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO messages (id,thread_id,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)', [message.id, message.threadId, message.senderId, message.body, message.createdAt]);
    const recipientId = conversation.buyer_id === req.session.user.id ? conversation.seller_id : conversation.buyer_id;
    await db.query('INSERT INTO notifications (id,user_id,kind,body,created_at) VALUES ($1,$2,$3,$4,$5)', [nanoid(), recipientId, 'message', 'You have a new marketplace message.', message.createdAt]);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.post('/api/offers', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({ listingId: z.string().min(1), sellerId: z.string().min(1), amountCents: z.number().int().positive(), message: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid offer payload' });

    const offer = { id: nanoid(), listingId: parsed.data.listingId, buyerId: req.session.user.id, sellerId: parsed.data.sellerId, amountCents: parsed.data.amountCents, message: parsed.data.message || null, createdAt: new Date().toISOString() };
    await db.query('INSERT INTO offers (id,listing_id,buyer_id,seller_id,amount_cents,message,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [offer.id, offer.listingId, offer.buyerId, offer.sellerId, offer.amountCents, offer.message, 'pending', offer.createdAt]);
    res.status(201).json({ offer });
  } catch (error) {
    next(error);
  }
});

export default router;
