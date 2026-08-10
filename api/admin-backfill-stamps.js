// Vercel serverless function: POST /api/admin-backfill-stamps
// ONE-TIME internal tool to retroactively award loyalty stamps for paid
// subscription orders placed before the stamps-recording fix went live.
// Not linked from any UI or menu. Delete this file once it's been used.
import getClient from './_redis.js';

const MIN_STAMP_PRICE = 1.25;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const orderCode = req.body && req.body.orderCode;
  if (!orderCode) {
    return res.status(400).json({ ok: false, error: 'Missing orderCode' });
  }

  try {
    const client = await getClient();
    const key = `order:${orderCode}`;
    const raw = await client.get(key);
    if (!raw) return res.status(404).json({ ok: false, error: 'Order not found' });

    let order;
    try { order = JSON.parse(raw); } catch (err) {
      return res.status(500).json({ ok: false, error: 'Corrupt order record' });
    }

    if (order.orderType !== 'subscription') {
      return res.status(400).json({ ok: false, error: 'Not a subscription order' });
    }
    if (order.status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'Order is not paid' });
    }
    if (order.stampsBackfilled) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'Already backfilled' });
    }
    const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'No customer id on order' });
    }

    const item = Array.isArray(order.items) ? order.items[0] : null;
    const subDays = Math.max(0, parseInt(order.subDays, 10) || 0);
    const subtotal = Number(order.subtotal) || 0;
    const unitPrice = item && item.unitPrice != null ? Number(item.unitPrice) : (subDays > 0 ? subtotal / subDays : 0);

    const totalKey = `user:${userId}:total`;
    const lastPriceKey = `user:${userId}:lastPrice`;

    let awarded = 0;
    if (unitPrice >= MIN_STAMP_PRICE && subDays > 0) {
      awarded = subDays;
      await client.incrBy(totalKey, awarded);
      const priorLastPriceStr = await client.get(lastPriceKey);
      const priorLastCupPrice = priorLastPriceStr != null ? parseFloat(priorLastPriceStr) : null;
      const newMaxPrice = Math.max(priorLastCupPrice || 0, unitPrice);
      await client.set(lastPriceKey, newMaxPrice.toFixed(2));
    }

    order.stampsBackfilled = true;
    const ttl = await client.ttl(key);
    const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
    await client.set(key, JSON.stringify(order), setOpts);

    const newTotalStr = await client.get(totalKey);
    return res.status(200).json({ ok: true, orderCode, userId, unitPrice, subDays, awarded, newTotal: newTotalStr });
  } catch (err) {
    console.error('Backfill failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
