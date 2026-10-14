import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { uploadDirectory } from '../config/storage.js';

const encryptionKey = crypto.createHash('sha256').update(process.env.UPLOAD_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'development-only').digest();

export async function processAndEncryptImage(buffer, mimeType = 'image/jpeg') {
  let processed = buffer;
  let outputMimeType = mimeType;

  if (mimeType.startsWith('image/')) {
    processed = await sharp(buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer();
    outputMimeType = 'image/webp';
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(processed), cipher.final()]);
  return { payload: Buffer.concat([iv, cipher.getAuthTag(), encrypted]), mimeType: outputMimeType };
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
  await fs.mkdir(uploadDirectory, { recursive: true });
  const filename = `${id}.enc`;
  await fs.writeFile(path.join(uploadDirectory, filename), payload);
  return filename;
}

export async function encryptFileToStorage(sourcePath, id) {
  await fs.mkdir(uploadDirectory, { recursive: true });
  const filename = `${id}.enc`;
  const encryptedPath = path.join(uploadDirectory, filename);
  const ciphertextPath = path.join(uploadDirectory, `${id}.cipher.tmp`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

  try {
    await pipeline(
      createReadStream(sourcePath),
      cipher,
      createWriteStream(ciphertextPath, { flags: 'wx', mode: 0o600 })
    );
    await fs.writeFile(encryptedPath, Buffer.concat([iv, cipher.getAuthTag()]), { flag: 'wx', mode: 0o600 });
    await pipeline(
      createReadStream(ciphertextPath),
      createWriteStream(encryptedPath, { flags: 'a', mode: 0o600 })
    );
    await fs.rm(ciphertextPath, { force: true });
    return filename;
  } catch (error) {
    await Promise.all([
      fs.rm(ciphertextPath, { force: true }),
      fs.rm(encryptedPath, { force: true })
    ]);
    throw error;
  }
}

export async function decryptFileToTemporaryStorage(filename) {
  const encryptedPath = path.join(uploadDirectory, path.basename(filename));
  const encryptedFile = await fs.open(encryptedPath, 'r');
  let header;
  try {
    header = Buffer.alloc(28);
    const { bytesRead } = await encryptedFile.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error('Encrypted book file is incomplete.');
  } finally {
    await encryptedFile.close();
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-book-'));
  const temporaryPath = path.join(temporaryDirectory, 'download.pdf');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, header.subarray(0, 12));
  decipher.setAuthTag(header.subarray(12, 28));

  try {
    await pipeline(
      createReadStream(encryptedPath, { start: header.length }),
      decipher,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    );
    const { size } = await fs.stat(temporaryPath);
    return {
      path: temporaryPath,
      size,
      cleanup: async () => {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function readEncryptedImage(filename) {
  const safeName = path.basename(filename);
  return fs.readFile(path.join(uploadDirectory, safeName));
}

export async function deleteEncryptedMedia(filename) {
  const safeName = path.basename(filename);
  await fs.rm(path.join(uploadDirectory, safeName), { force: true });
}
