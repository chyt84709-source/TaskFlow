import crypto from 'node:crypto';

export function hash(value) {
  return crypto.createHash('sha256').update(`${value}:${process.env.SESSION_SECRET || 'development-only'}`).digest('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, storedValue) {
  if (!storedValue || typeof storedValue !== 'string') return false;
  const [salt, hashValue] = storedValue.split(':');
  if (!salt || !hashValue) return false;
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hashValue, 'hex'), Buffer.from(derived, 'hex'));
}

export function now() {
  return new Date().toISOString();
}

export function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
