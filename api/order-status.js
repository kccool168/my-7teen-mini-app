// Vercel serverless function: GET /api/order-status?code=<order code>
// Looks up an order's payment status (pending / paid / unpaid) from Redis,
// plus subscription details when relevant. Used by the Mini App's confirm
// screen to live-poll the real status, and for spot-checking an order by
// its Inv. ID (e.g. "7T-512").
import getClient from './_redis.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ ok: false, error: 'Missing code' });
  }

  try {
    const client = await getClient();
    const raw = await client.get(`order:${code}`);
    if (!raw) {
      return res.status(404).json({ ok: false, error: 'Order not found (expired after 14 days, or never existed)' });
    }
    const order = JSON.parse(raw);
    return res.status(200).json({
      ok: true,
      orderCode: order.orderCode,
      status: order.status,
      total: order.total,
      confirmedByName: order.confirmedByName || null,
      confirmedAt: order.confirmedAt || null,
      timestamp: order.timestamp,
      orderType: order.orderType || 'single',
      subStartDate: order.subStartDate || null,
      subDays: order.subDays || null,
      subValidUntil: order.subValidUntil || null,
      subDates: order.subDates || null,
      subRedeemedDates: order.subRedeemedDates || null,
    });
  } catch (err) {
    console.error('Order status lookup failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
