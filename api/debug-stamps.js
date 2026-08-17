// TEMPORARY debug: GET /api/debug-stamps?username=<telegram username, no @>
// Dumps every order for that username plus their current Redis stamp
// counters, so we can verify the redeemed-free-cup stamp logic didn't
// double-count. Delete this file once no longer needed.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;
const MIN_STAMP_PRICE = 1.25;

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  const target = String(req.query.username || 'tangseakmeng').toLowerCase();

  const orders = [];
  let userId = null;
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const uname = order.customer && order.customer.username ? String(order.customer.username).toLowerCase() : '';
      if (uname !== target) continue;
      if (order.customer && order.customer.id != null) userId = String(order.customer.id);
      orders.push({
        orderCode: order.orderCode,
        timestamp: order.timestamp,
        orderType: order.orderType || 'single',
        redeemedFreeCup: !!order.redeemedFreeCup,
        items: (order.items || []).map((it) => ({ name: it.name, qty: it.qty, unitPrice: it.unitPrice })),
        subDays: order.subDays || null,
        stampsAtOrder: order.stamps,
        freeCupsAtOrder: order.freeCups,
        status: order.status,
      });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed', details: String(err) });
  }

  orders.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  let expectedTotal = 0;
  let expectedUsed = 0;
  for (const o of orders) {
    if (o.orderType === 'subscription') {
      const unit = o.items[0] ? Number(o.items[0].unitPrice) || 0 : 0;
      const days = o.subDays || 0;
      if (unit >= MIN_STAMP_PRICE) expectedTotal += days;
    } else {
      const eligible = o.items.reduce((sum, it) => {
        const p = Number(it.unitPrice) || 0;
        return sum + (p >= MIN_STAMP_PRICE ? (Number(it.qty) || 0) : 0);
      }, 0);
      const earn = Math.max(0, eligible - (o.redeemedFreeCup ? 1 : 0));
      expectedTotal += earn;
      if (o.redeemedFreeCup) expectedUsed += 1;
    }
  }

  let actualTotal = null, actualUsed = null;
  if (userId) {
    const totalStr = await client.get(`user:${userId}:total`);
    const usedStr = await client.get(`user:${userId}:used`);
    actualTotal = parseInt(totalStr || '0', 10) || 0;
    actualUsed = parseInt(usedStr || '0', 10) || 0;
  }

  return res.status(200).json({
    ok: true, username: target, userId,
    orderCount: orders.length, orders,
    expectedTotal, expectedUsed, actualTotal, actualUsed,
    mismatch: userId ? (expectedTotal !== actualTotal || expectedUsed !== actualUsed) : null,
  });
}
