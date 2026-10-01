import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { db } from '../../config/database.js';
import { requireUser } from '../../utils/helpers.js';
import { decryptImage, processAndEncryptImage, readEncryptedImage, saveEncryptedImage } from '../../services/media.js';

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif|avif|heic)$/.test(file.mimetype)) });
const router = express.Router();

router.post('/api/profile/avatar', requireUser, imageUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'An image file is required.' });
    const image = await processAndEncryptImage(req.file.buffer);
    const id = nanoid();
    const filename = await saveEncryptedImage(image.payload, id);
    const savedImage = await readEncryptedImage(filename);
    if (!decryptImage(savedImage).length) throw new Error('Uploaded image could not be verified from storage.');
    await db.query('INSERT INTO media_files (id,user_id,filename,mime_type,purpose) VALUES ($1,$2,$3,$4,$5)', [id, req.session.user.id, filename, image.mimeType, 'profile-avatar']);
    const avatarUrl = `/api/media/${id}`;
    await db.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [avatarUrl, req.session.user.id]);
    await db.query('INSERT INTO profiles (id,user_id,avatar_url,created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (user_id) DO UPDATE SET avatar_url=EXCLUDED.avatar_url', [nanoid(), req.session.user.id, avatarUrl]);
    req.session.user.avatarUrl = avatarUrl;
    req.session.user.avatar_url = avatarUrl;
    res.status(201).json({ url: avatarUrl, mimeType: image.mimeType });
  } catch (error) {
    next(error);
  }
});

router.get('/api/media/:id', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT m.filename,m.mime_type AS "mimeType",m.purpose,m.user_id AS "userId",u.account_status AS "accountStatus",
      (EXISTS (SELECT 1 FROM products p
        WHERE p.status='active'
          AND (p.media @> jsonb_build_array('/api/media/' || m.id)
            OR p.media @> jsonb_build_array(jsonb_build_object('url', '/api/media/' || m.id))))
        OR EXISTS (SELECT 1 FROM listings l
          WHERE l.status='active'
            AND (l.media @> jsonb_build_array('/api/media/' || m.id)
              OR l.media @> jsonb_build_array(jsonb_build_object('url', '/api/media/' || m.id))))
        OR EXISTS (SELECT 1 FROM stores s
          WHERE s.status='verified'
            AND (s.logo_url='/api/media/' || m.id OR s.cover_url='/api/media/' || m.id))
        OR EXISTS (SELECT 1 FROM ads a
        WHERE a.status='active'
          AND a.created_at + (COALESCE(a.duration_days, 7) * INTERVAL '1 day') >= NOW()
          AND (a.media @> jsonb_build_array('/api/media/' || m.id)
            OR a.media @> jsonb_build_array(jsonb_build_object('url', '/api/media/' || m.id))))) AS "publiclyLinked"
      FROM media_files m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=$1`, [req.params.id]);
    const media = result.rows[0];
    const sharedMedia = media?.purpose === 'marketplace-media' || media?.purpose === 'ad-media';
    const user = req.session?.user;
    const adminAccess = user?.isAdmin || user?.role === 'admin';
    const ownerAccess = user?.id === media?.userId;
    const ownerCanShare = sharedMedia && media.accountStatus === 'active';
    const publicAccess = ownerCanShare && Boolean(media?.publiclyLinked);
    if (!media || (!adminAccess && !ownerAccess && !publicAccess)) return res.status(404).end();
    try {
      const encrypted = await readEncryptedImage(media.filename);
      const payload = decryptImage(encrypted);
      const totalBytes = payload.length;
      const range = req.headers.range;
      res.set('Accept-Ranges', 'bytes');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return res.status(416).set('Content-Range', `bytes */${totalBytes}`).end();
        const start = match[1] ? Number(match[1]) : Math.max(0, totalBytes - Number(match[2] || 0));
        const end = match[2] ? Number(match[2]) : totalBytes - 1;
        if (start >= totalBytes || end < start || end >= totalBytes) return res.status(416).set('Content-Range', `bytes */${totalBytes}`).end();
        const chunk = payload.subarray(start, end + 1);
        return res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${totalBytes}`, 'Content-Length': String(chunk.length) }).type(media.mimeType).send(chunk);
      }
      res.set('Content-Length', String(totalBytes)).type(media.mimeType).send(payload);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).end();
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

export default router;
