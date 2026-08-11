// TEMPORARY admin endpoint — manually grant bonus loyalty stamps to a
// user (Redis key user:<id>:total). Deleted immediately after use.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  var body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  var userId = body && body.userId;
  var amount = body && parseInt(body.amount, 10);
  if (!userId || !amount || amount <= 0) return res.status(400).json({ ok: false, error: 'Missing userId or amount' });
  try {
    var client = await getClient();
    var totalKey = 'user:' + userId + ':total';
    var usedKey = 'user:' + userId + ':used';
    var newTotal = await client.incrBy(totalKey, amount);
    var usedStr = await client.get(usedKey);
    var used = parseInt(usedStr || '0', 10) || 0;
    var stamps = newTotal % STAMPS_NEEDED;
    var freeCups = Math.max(0, Math.floor(newTotal / STAMPS_NEEDED) - used);
    return res.status(200).json({ ok: true, userId: userId, added: amount, newTotal: newTotal, stamps: stamps, freeCups: freeCups });
  } catch (err) {
    console.error('admin-add-stamps failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
