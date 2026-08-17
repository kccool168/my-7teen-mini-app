// TEMPORARY debug: GET /api/debug-subs?username=<telegram username, no @>
// Dumps every subscription order for that username, full record, so we can
// see current drink/date-range before editing. Read-only. Delete this file
// once no longer needed.
import getClient from './_redis.js';

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  const target = String(req.query.username || '').toLowerCase();
  if (!target) {
    return res.status(400).json({ ok: false, error: 'Missing username query param' });
  }

  const results = [];
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const uname = order.customer && order.customer.username ? String(order.customer.username).toLowerCase() : '';
      if (uname !== target) continue;
      if (order.orderType !== 'subscription') continue;
      results.push({ key, order });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed', details: String(err) });
  }

  const activeCodes = await client.sMembers('active_subscriptions');

  return res.status(200).json({ ok: true, username: target, count: results.length, results, activeCodes });
}
