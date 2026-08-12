// Vercel serverless function: GET /api/report-1pm
//
// Read-only diagnostic: lists (a) every order placed since 1:00 PM Cambodia
// time today, and (b) every customer with a currently active paid
// subscription. Never sends any Telegram messages. Delete once no longer
// needed.
import getClient from './_redis.js';
import { todayInPhnomPenh, formatTimestamp, formatCalendarDate } from './_format.js';

export default async function handler(req, res) {
    let client;
    try {
          client = await getClient();
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Database unavailable' });
    }

  const today = todayInPhnomPenh();
    const windowStart = new Date(`${today}T06:00:00.000Z`).getTime();
    const now = Date.now();

  const ordersSince1pm = [];
    try {
          for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
                  const raw = await client.get(key);
                  if (!raw) continue;
                  let order;
                  try { order = JSON.parse(raw); } catch (e) { continue; }
                  const ts = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
                  if (isNaN(ts) || ts < windowStart || ts > now) continue;

            const c = order.customer || {};
                  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer';
                  const itemsSummary = Array.isArray(order.items)
                    ? order.items.map((item) => `${item.qty}x ${item.name}`).join(', ')
                            : '';
                  ordersSince1pm.push({
                            orderCode: order.orderCode || '',
                            orderType: order.orderType === 'subscription' ? 'Subscription' : 'Single',
                            name, username: c.username ? `@${c.username}` : '',
                            items: itemsSummary, total: Number(order.total) || 0,
                            status: order.status || '', time: formatTimestamp(order.timestamp),
                  });
          }
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Scan failed (orders)' });
    }
    ordersSince1pm.sort((a, b) => a.time.localeCompare(b.time));

  const subscribers = [];
    try {
          const subCodes = await client.sMembers('active_subscriptions');
          for (const code of subCodes) {
                  const raw = await client.get(`order:${code}`);
                  if (!raw) continue;
                  let order;
                  try { order = JSON.parse(raw); } catch (e) { continue; }
                  const c = order.customer || {};
                  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer';
                  const item = Array.isArray(order.items) ? order.items[0] : null;
                  subscribers.push({
                            orderCode: order.orderCode || code,
                            name, username: c.username ? `@${c.username}` : '',
                            drink: item ? item.name : '',
                            validUntil: order.subValidUntil ? formatCalendarDate(order.subValidUntil) : '',
                            subDays: order.subDays || null,
                  });
          }
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Scan failed (subscribers)' });
    }

  return res.status(200).json({
        ok: true,
        ordersSince1pmCount: ordersSince1pm.length,
        ordersSince1pm,
        activeSubscribersCount: subscribers.length,
        subscribers,
  });
}
