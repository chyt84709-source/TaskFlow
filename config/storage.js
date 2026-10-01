import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredUploadDirectory = process.env.UPLOAD_DIR?.trim();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const uploadDirectory = process.env.NODE_ENV === 'production'
  ? '/app/upload'
  : path.resolve(projectRoot, configuredUploadDirectory || './data/uploads');
