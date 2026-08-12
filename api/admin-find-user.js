// TEMPORARY admin endpoint — find a customer's Telegram id by username
// by scanning live order records. Deleted immediately after use.
import getClient from './_redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  var username = (req.query.username || '').toLowerCase();
  if (!username) return res.status(400).json({ ok: false, error: 'Missing username' });
  try {
    var client = await getClient();
    var matches = [];
    for await (var key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      var raw = await client.get(key);
      if (!raw) continue;
      try {
        var o = JSON.parse(raw);
        var uname = o.customer && o.customer.username ? String(o.customer.username).toLowerCase() : '';
        if (uname.indexOf(username) !== -1) {
          matches.push({ orderCode: o.orderCode, customerId: o.customer.id, customerName: (o.customer.firstName||'') + ' ' + (o.customer.username||''), timestamp: o.timestamp });
        }
      } catch (e) {}
    }
    return res.status(200).json({ ok: true, matches: matches });
  } catch (err) {
    console.error('admin-find-user failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
