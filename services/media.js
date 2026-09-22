import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const mediaDir = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const encryptionKey = crypto.createHash('sha256').update(process.env.UPLOAD_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'development-only').digest();

export async function processAndEncryptImage(buffer) {
  const processed = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(processed), cipher.final()]);
  return { payload: Buffer.concat([iv, cipher.getAuthTag(), encrypted]), mimeType: 'image/webp' };
}

export function decryptImage(payload) {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function saveEncryptedImage(payload, id) {
  await fs.mkdir(mediaDir, { recursive: true });
  const filename = `${id}.enc`;
  await fs.writeFile(path.join(mediaDir, filename), payload);
  return filename;
}

export async function readEncryptedImage(filename) {
  const safeName = path.basename(filename);
  return fs.readFile(path.join(mediaDir, safeName));
}
