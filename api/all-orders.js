// Vercel serverless function: GET /api/all-orders
//
// Scans every order record currently in Redis (order:*) and returns them
// pre-shaped into the flat row format the Google Sheets order-log sync
// (Apps Script Web App) expects — see orderToSheetRow in api/_format.js.
// Used for the one-time historical backfill into the sheet; ongoing sync
// happens per-order from api/order.js and api/telegram-webhook.js instead.
//
// Secret-protected the same way as the cron endpoints: if CRON_SECRET is
// set, callers must send it as a Bearer token. Orders older than 14 days
// have already expired out of Redis (see ORDER_TTL_SECONDS in order.js), so
// this only ever returns what's still live.
import getClient from './_redis.js';
import { orderToSheetRow } from './_format.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for all-orders export', err);
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  const records = [];
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw));
      } catch (e) {
        console.error('Skipping unparsable order record', key, e);
      }
    }
  } catch (err) {
    console.error('Redis scan failed', err);
    return res.status(500).json({ ok: false, error: 'Scan failed' });
  }

  // Oldest first, so a bulk import lands in the sheet in chronological order.
  records.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  const orders = records.map(orderToSheetRow);

  return res.status(200).json({ ok: true, count: orders.length, orders });
}
