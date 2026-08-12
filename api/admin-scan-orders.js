// TEMPORARY admin endpoint — scan every live order record in Redis and
// return a trimmed summary (no secret required; deleted after use).
import getClient from './_redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    var client = await getClient();
    var records = [];
    for await (var key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      var raw = await client.get(key);
      if (!raw) continue;
      try {
        var o = JSON.parse(raw);
        records.push({
          orderCode: o.orderCode,
          customerId: o.customer && o.customer.id != null ? o.customer.id : null,
          customerName: o.customer ? ((o.customer.firstName||'') + ' ' + (o.customer.username||'')) : null,
          timestamp: o.timestamp
        });
      } catch (e) {}
    }
    records.sort(function(a,b){ return new Date(a.timestamp||0) - new Date(b.timestamp||0); });
    return res.status(200).json({ ok: true, count: records.length, orders: records });
  } catch (err) {
    console.error('admin-scan-orders failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
