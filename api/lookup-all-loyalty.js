// TEMPORARY one-off: GET /api/lookup-all-loyalty
// Scans every known customer (from order:* records) and reports their
// current stamps, free cups, and last cup price straight from Redis.
// Read-only, does not write to the Sheet. Delete this file once no longer
// needed.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

const customers = new Map();
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const cust = order.customer;
      if (!cust || cust.id == null) continue;
      customers.set(String(cust.id), cust);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed', details: String(err) });
  }

const results = [];
  for (const [userId, cust] of customers) {
    const totalKey = `user:${userId}:total`;
    const usedKey = `user:${userId}:used`;
    const lastPriceKey = `user:${userId}:lastPrice`;
    const totalStr = await client.get(totalKey);
    const usedStr = await client.get(usedKey);
    const lastPriceStr = await client.get(lastPriceKey);
    const total = parseInt(totalStr || '0', 10) || 0;
    const used = parseInt(usedStr || '0', 10) || 0;
    const stamps = total % STAMPS_NEEDED;
    const freeCups = Math.max(0, Math.floor(total / STAMPS_NEEDED) - used);
    const lastCupPrice = lastPriceStr != null ? parseFloat(lastPriceStr) : null;
    const name = [cust.firstName, cust.lastName].filter(Boolean).join(' ');
    results.push({ name, username: cust.username || null, userId, total, used, stamps, freeCups, lastCupPrice });
  }

results.sort((a, b) => (b.freeCups - a.freeCups) || (b.stamps - a.stamps));

return res.status(200).json({ ok: true, count: results.length, customers: results });
}
