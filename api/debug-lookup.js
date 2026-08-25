import getClient from './_redis.js';

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }
  const namesParam = String((req.query && req.query.names) || '').toLowerCase();
  const names = namesParam.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  const results = [];
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const c = order.customer || {};
      const username = (c.username || '').toLowerCase();
      if (!names.length || names.indexOf(username) !== -1) results.push(order);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed' });
  }
  results.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  const activeSubs = await client.sMembers('active_subscriptions');
  return res.status(200).json({ ok: true, count: results.length, orders: results, activeSubscriptions: activeSubs });
}
