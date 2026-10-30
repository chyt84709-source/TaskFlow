import { app, appInitialization } from '../server.js';

export default async function handler(req, res) {
  try {
    await appInitialization;
    return app(req, res);
  } catch (error) {
    console.error('Vercel app initialization failed:', error);
    if (!res.headersSent) return res.status(500).json({ error: 'The service is temporarily unavailable.' });
  }
}
