// TEMPORARY admin endpoint — manually correct a user's tracked
// last-cup-price cap (Redis key user:<id>:lastPrice). Deleted after use.
import getClient from './_redis.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  var body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  var userId = body && body.userId;
  var price = body && Number(body.price);
  if (!userId || !price || isNaN(price)) return res.status(400).json({ ok: false, error: 'Missing userId or price' });
  try {
    var client = await getClient();
    var key = 'user:' + userId + ':lastPrice';
    var before = await client.get(key);
    await client.set(key, price.toFixed(2));
    return res.status(200).json({ ok: true, userId: userId, before: before, after: price.toFixed(2) });
  } catch (err) {
    console.error('admin-set-lastprice failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
