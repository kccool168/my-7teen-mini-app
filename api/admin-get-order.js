// TEMPORARY admin endpoint — read a single raw order record from Redis
// for support/debugging. Deleted immediately after use.
import getClient from './_redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  var code = req.query.code;
  if (!code) return res.status(400).json({ ok: false, error: 'Missing code' });
  try {
    var client = await getClient();
    var raw = await client.get('order:' + code);
    if (!raw) return res.status(404).json({ ok: false, error: 'Order not found' });
    return res.status(200).json({ ok: true, order: JSON.parse(raw) });
  } catch (err) {
    console.error('admin-get-order failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
