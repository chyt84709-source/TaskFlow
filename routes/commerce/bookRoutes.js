import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { calculateInternationalTax, db } from '../../config/database.js';
import { decryptFileToTemporaryStorage, deleteEncryptedMedia, encryptFileToStorage } from '../../services/media.js';
import { ensureWalletReady, requireUser, updateTrustScoreOnSuccessfulTransaction } from '../../utils/helpers.js';
import { uploadDirectory } from '../../config/storage.js';

const router = express.Router();
const bookTypes = ['book', 'article', 'newspaper'];
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, _file, callback) => callback(null, `${nanoid()}.upload`)
  }),
  fileFilter: (_req, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith('.pdf')) return callback(new Error('Choose a PDF file.'));
    callback(null, true);
  }
});

function uploadPdf(req, res, next) {
  pdfUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    res.status(400).json({ error: error.message || 'The PDF could not be uploaded.' });
  });
}

const bookSelect = `SELECT b.id,b.seller_id AS "sellerId",b.store_id AS "storeId",b.content_type AS "contentType",
    b.title,b.description,b.price_cents AS "priceCents",b.status,b.created_at AS "createdAt",
    b.published_at AS "publishedAt",u.name AS "sellerName",s.business_name AS "storeName",
    COUNT(bf.id)::int AS "fileCount",
    COALESCE(json_agg(json_build_object('id',bf.id,'name',bf.name,'sizeBytes',bf.size_bytes) ORDER BY bf.position)
      FILTER (WHERE bf.id IS NOT NULL),'[]'::json) AS files,
    EXISTS (SELECT 1 FROM book_orders bo WHERE bo.book_id=b.id AND bo.buyer_id=$1 AND bo.status IN ('paid','processing','shipped','completed')) AS "hasPurchased"
  FROM books b
  JOIN users u ON u.id=b.seller_id
  LEFT JOIN stores s ON s.id=b.store_id
  LEFT JOIN book_files bf ON bf.book_id=b.id`;

async function findOwnedBook(bookId, sellerId, allowedStatuses = ['draft']) {
  const result = await db.query('SELECT id,status FROM books WHERE id=$1 AND seller_id=$2 AND status=ANY($3::text[])', [bookId, sellerId, allowedStatuses]);
  return result.rows[0] || null;
}

router.get('/api/books', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const type = String(req.query.type || '').trim();
    if (type && !bookTypes.includes(type)) return res.status(400).json({ error: 'Choose a valid book, article, or newspaper type.' });
    const params = [req.session?.user?.id || null];
    const conditions = ["b.status='active'", "u.account_status='active'"];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(b.title ILIKE $${params.length} OR b.description ILIKE $${params.length} OR s.business_name ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      conditions.push(`b.content_type=$${params.length}`);
    }
    const result = await db.query(`${bookSelect}
      WHERE ${conditions.join(' AND ')}
      GROUP BY b.id,u.name,s.business_name
      ORDER BY b.published_at DESC NULLS LAST,b.created_at DESC`, params);
    res.json({ books: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get('/api/books/mine', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`${bookSelect}
      WHERE b.seller_id=$2
      GROUP BY b.id,u.name,s.business_name
      ORDER BY b.created_at DESC`, [req.session.user.id, req.session.user.id]);
    res.json({ books: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api/books/drafts', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      title: z.string().trim().min(3).max(160),
      contentType: z.enum(['book', 'article', 'newspaper']),
      description: z.string().trim().min(5).max(4000),
      priceCents: z.number().int().min(0).max(100000000),
      storeId: z.string().min(1).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter valid publication details.' });

    if (parsed.data.storeId) {
      const store = await db.query("SELECT id FROM stores WHERE id=$1 AND owner_id=$2 AND status='verified'", [parsed.data.storeId, req.session.user.id]);
      if (!store.rows[0]) return res.status(400).json({ error: 'Choose one of your verified stores.' });
    }
    const id = nanoid();
    await db.query(`INSERT INTO books (id,seller_id,store_id,content_type,title,description,price_cents,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',NOW())`,
    [id, req.session.user.id, parsed.data.storeId || null, parsed.data.contentType, parsed.data.title, parsed.data.description, parsed.data.priceCents]);
    res.status(201).json({ book: { id, ...parsed.data, sellerId: req.session.user.id, status: 'draft', fileCount: 0 } });
  } catch (error) {
    next(error);
  }
});

router.patch('/api/books/:id/draft', requireUser, async (req, res, next) => {
  try {
    const parsed = z.object({
      title: z.string().trim().min(3).max(160),
      contentType: z.enum(['book', 'article', 'newspaper']),
      description: z.string().trim().min(5).max(4000),
      priceCents: z.number().int().min(0).max(100000000),
      storeId: z.string().min(1).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter valid publication details.' });

    if (parsed.data.storeId) {
      const store = await db.query("SELECT id FROM stores WHERE id=$1 AND owner_id=$2 AND status='verified'", [parsed.data.storeId, req.session.user.id]);
      if (!store.rows[0]) return res.status(400).json({ error: 'Choose one of your verified stores.' });
    }
    const result = await db.query(`UPDATE books SET store_id=$1,content_type=$2,title=$3,description=$4,price_cents=$5
      WHERE id=$6 AND seller_id=$7 AND status='draft' RETURNING id`,
    [parsed.data.storeId || null, parsed.data.contentType, parsed.data.title, parsed.data.description, parsed.data.priceCents, req.params.id, req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Your book draft was not found.' });
    res.json({ updated: true });
  } catch (error) {
    next(error);
  }
});

router.post('/api/books/:id/files', requireUser, uploadPdf, async (req, res, next) => {
  let encryptedFilename;
  let client;
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF file to upload.' });
    const book = await findOwnedBook(req.params.id, req.session.user.id);
    if (!book) return res.status(404).json({ error: 'Your book draft was not found.' });

    const input = await fs.open(req.file.path, 'r');
    let signature;
    try {
      signature = Buffer.alloc(5);
      const { bytesRead } = await input.read(signature, 0, signature.length, 0);
      if (bytesRead !== signature.length || signature.toString('ascii') !== '%PDF-') {
        return res.status(400).json({ error: 'The selected file is not a valid PDF.' });
      }
    } finally {
      await input.close();
    }

    const name = req.file.originalname.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!name || name.length > 255) return res.status(400).json({ error: 'The PDF filename must be between 1 and 255 characters.' });

    const mediaId = nanoid();
    const bookFileId = nanoid();
    encryptedFilename = await encryptFileToStorage(req.file.path, mediaId);
    client = await db.connect();
    await client.query('BEGIN');
    const filePosition = await client.query('SELECT COALESCE(MAX(position)+1,0)::int AS position FROM book_files WHERE book_id=$1', [req.params.id]);
    await client.query('INSERT INTO media_files (id,user_id,filename,mime_type,purpose) VALUES ($1,$2,$3,$4,$5)', [mediaId, req.session.user.id, encryptedFilename, 'application/pdf', 'book-download']);
    await client.query(`INSERT INTO book_files (id,book_id,media_id,name,size_bytes,position)
      VALUES ($1,$2,$3,$4,$5,$6)`, [bookFileId, req.params.id, mediaId, name, req.file.size, filePosition.rows[0].position]);
    await client.query('COMMIT');
    encryptedFilename = null;
    res.status(201).json({ file: { id: bookFileId, name, sizeBytes: req.file.size } });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch((rollbackError) => console.error('Book PDF upload rollback failed:', rollbackError));
    if (encryptedFilename) {
      try {
        await deleteEncryptedMedia(encryptedFilename);
      } catch (cleanupError) {
        console.error('Book upload cleanup failed:', cleanupError);
      }
    }
    next(error);
  } finally {
    client?.release();
    if (req.file?.path) {
      try {
        await fs.rm(req.file.path, { force: true });
      } catch (cleanupError) {
        console.error('Temporary book upload cleanup failed:', cleanupError);
      }
    }
  }
});

router.post('/api/books/:id/publish', requireUser, async (req, res, next) => {
  try {
    const result = await db.query(`UPDATE books b SET status='active',published_at=NOW()
      WHERE b.id=$1 AND b.seller_id=$2 AND b.status='draft'
        AND EXISTS (SELECT 1 FROM book_files bf WHERE bf.book_id=b.id)
      RETURNING b.id,b.title,b.content_type AS "contentType",b.status,b.published_at AS "publishedAt"`,
    [req.params.id, req.session.user.id]);
    if (!result.rows[0]) {
      const draft = await findOwnedBook(req.params.id, req.session.user.id);
      if (!draft) return res.status(404).json({ error: 'Your book draft was not found.' });
      return res.status(400).json({ error: 'Upload at least one PDF before publishing.' });
    }
    res.status(201).json({ book: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post('/api/books/:id/purchase', requireUser, async (req, res, next) => {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const result = await client.query(`SELECT id,seller_id AS "sellerId",title,price_cents AS "priceCents"
      FROM books WHERE id=$1 AND status='active' FOR UPDATE`, [req.params.id]);
    const book = result.rows[0];
    if (!book) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Publication not found.' });
    }
    if (book.sellerId === req.session.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot purchase your own publication.' });
    }
    if (Number(book.priceCents) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This publication is free; download it directly.' });
    }
    const existing = await client.query("SELECT id FROM book_orders WHERE book_id=$1 AND buyer_id=$2 AND status IN ('paid','processing','shipped','completed')", [book.id, req.session.user.id]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You already own this publication.' });
    }
    const countryResult = await client.query('SELECT country FROM users WHERE id=$1', [req.session.user.id]);
    const tax = calculateInternationalTax(Number(book.priceCents), countryResult.rows[0]?.country || req.session.user.country);
    const amountCents = Number(book.priceCents) + tax.taxCents;
    await ensureWalletReady(req.session.user.id, amountCents);
    const orderId = nanoid();
    const createdAt = new Date().toISOString();
    const feeCents = Math.round(amountCents * 0.01);
    await client.query(`INSERT INTO book_orders (id,book_id,buyer_id,seller_id,amount_cents,fee_cents,status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'paid',$7)`, [orderId, book.id, req.session.user.id, book.sellerId, amountCents, feeCents, createdAt]);
    await client.query(`INSERT INTO transactions (id,user_id,kind,amount_cents,status,metadata,created_at)
      VALUES ($1,$2,'book_purchase',$3,'paid',$4,$5)`,
    [nanoid(), req.session.user.id, amountCents, { bookId: book.id, taxCents: tax.taxCents, internationalTax: tax.isInternational, feeCents }, createdAt]);
    await client.query(`INSERT INTO notifications (id,user_id,kind,body,created_at)
      VALUES ($1,$2,'order',$3,$4)`, [nanoid(), book.sellerId, `New publication sale: ${book.title}.`, createdAt]);
    await client.query('COMMIT');
    try {
      await updateTrustScoreOnSuccessfulTransaction(req.session.user.id);
    } catch (error) {
      console.error('Trust score update failed after book purchase:', error);
    }
    res.status(201).json({ orderId, totalCents: amountCents });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch((rollbackError) => console.error('Book purchase rollback failed:', rollbackError));
    next(error);
  } finally {
    client?.release();
  }
});

router.get('/api/books/:id/files/:fileId/download', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT b.seller_id AS "sellerId",b.price_cents AS "priceCents",b.status,
        bf.name,m.filename,m.purpose,m.mime_type AS "mimeType"
      FROM books b
      JOIN users seller ON seller.id=b.seller_id AND seller.account_status='active'
      JOIN book_files bf ON bf.book_id=b.id
      JOIN media_files m ON m.id=bf.media_id
      WHERE b.id=$1 AND bf.id=$2 AND (b.status='active' OR b.seller_id=$3)`,
    [req.params.id, req.params.fileId, req.session?.user?.id || null]);
    const file = result.rows[0];
    if (!file || file.purpose !== 'book-download' || file.mimeType !== 'application/pdf') return res.status(404).end();

    const viewer = req.session?.user;
    const ownerAccess = viewer?.id === file.sellerId;
    const adminAccess = viewer?.isAdmin || viewer?.role === 'admin';
    if (Number(file.priceCents) > 0 && !ownerAccess && !adminAccess) {
      if (!viewer) return res.status(401).json({ error: 'Purchase this publication before downloading it.' });
      const access = await db.query("SELECT 1 FROM book_orders WHERE book_id=$1 AND buyer_id=$2 AND status IN ('paid','processing','shipped','completed')", [req.params.id, viewer.id]);
      if (!access.rows[0]) return res.status(403).json({ error: 'Purchase this publication before downloading it.' });
    }

    const download = await decryptFileToTemporaryStorage(file.filename);
    const filename = String(file.name || 'publication.pdf').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'publication.pdf';
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.download(download.path, filename, async (error) => {
      try {
        await download.cleanup();
      } catch (cleanupError) {
        console.error('Downloaded book cleanup failed:', cleanupError);
      }
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).end();
    next(error);
  }
});
