// Vercel serverless function: GET /api/subscription-expiry-check
//
// Runs once a day via Vercel Cron (see vercel.json). Scans every currently
// paid subscription and messages the customer directly on the day their
// subscription's last valid date arrives, so they know to top up. Each
// subscription is only ever notified once (subExpiryNotified flag), and is
// dropped from the tracking set right after — a 14-day order TTL means the
// record itself disappears on its own eventually regardless.
import getClient from './_redis.js';
import { todayInPhnomPenh } from './_format.js';

export default async function handler(req, res) {
  // Vercel Cron sends GET requests; allow POST too for manual testing.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // If Vercel's cron secret is configured, require it — stops random
  // internet requests from spamming customers or wasting invocations.
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for subscription expiry check', err);
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  const today = todayInPhnomPenh();
  const codes = await client.sMembers('active_subscriptions');
  let notified = 0;
  let checked = 0;

  for (const code of codes) {
    checked++;
    const key = `order:${code}`;
    const raw = await client.get(key);
    if (!raw) { await client.sRem('active_subscriptions', code); continue; }

    let order;
    try { order = JSON.parse(raw); } catch (e) { await client.sRem('active_subscriptions', code); continue; }

    if (order.orderType !== 'subscription' || order.status !== 'paid') {
      await client.sRem('active_subscriptions', code);
      continue;
    }
    if (order.subExpiryNotified) { await client.sRem('active_subscriptions', code); continue; }

    // Notify on the last valid day itself (or if a cron run was somehow
    // missed and we're already past it — still notify once, late).
    if (order.subValidUntil && order.subValidUntil <= today) {
      const userId = order.customerChatId || (order.customer && order.customer.id);
      if (userId) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: userId,
              text: '⏰ Your Subscription expired today, please top up for next delicious drinks ☕😋',
              parse_mode: 'HTML',
            }),
          });
          notified++;
        } catch (err) {
          console.error(`Expiry notify failed for ${code}`, err);
        }
      }

      order.subExpiryNotified = true;
      const ttl = await client.ttl(key);
      const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
      await client.set(key, JSON.stringify(order), setOpts);
      await client.sRem('active_subscriptions', code);
    }
  }

  return res.status(200).json({ ok: true, checked, notified });
}
