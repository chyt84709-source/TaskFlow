import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredUploadDirectory = process.env.UPLOAD_DIR?.trim();
if (!configuredUploadDirectory) throw new Error('UPLOAD_DIR environment variable is required.');
if (process.env.NODE_ENV === 'production' && !path.isAbsolute(configuredUploadDirectory)) {
  throw new Error('UPLOAD_DIR must be an absolute path to persistent storage in production.');
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const uploadDirectory = path.resolve(projectRoot, configuredUploadDirectory);
