import getClient from './_redis.js';

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }
  const q = String((req.query && req.query.name) || '').toLowerCase();
  const results = [];
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const c = order.customer || {};
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ').toLowerCase();
      const username = (c.username || '').toLowerCase();
      if (!q || name.indexOf(q) !== -1 || username.indexOf(q) !== -1) results.push(order);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed' });
  }
  results.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  return res.status(200).json({ ok: true, count: results.length, orders: results });
}
