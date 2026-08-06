// Vercel serverless function: GET /api/stamps?userId=<telegram user id>
// Returns the customer's persisted loyalty stamp count and available free
// cups, read from Redis. Called by the Mini App on boot so loyalty progress
// survives across visits instead of resetting every time the app reloads.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'Missing userId' });
  }

  try {
    const client = await getClient();
    const [totalStr, usedStr] = await Promise.all([
      client.get(`user:${userId}:total`),
      client.get(`user:${userId}:used`),
    ]);
    const total = parseInt(totalStr || '0', 10) || 0;
    const used = parseInt(usedStr || '0', 10) || 0;
    const stamps = total % STAMPS_NEEDED;
    const freeCups = Math.max(0, Math.floor(total / STAMPS_NEEDED) - used);
    return res.status(200).json({ ok: true, stamps, freeCups });
  } catch (err) {
    console.error('Stamps lookup failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
