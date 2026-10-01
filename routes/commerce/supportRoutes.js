import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { calculateInternationalTax, db, normalizeCountry } from '../../config/database.js';
import { ensureWalletReady, requireAdmin, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';

const router = express.Router();

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


export default router;
