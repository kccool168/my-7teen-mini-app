// Vercel serverless function: GET /api/daily-order-summary
//
// Runs once a day via Vercel Cron (see vercel.json — scheduled 23:30 UTC,
// i.e. 6:30 AM the next day in Cambodia time). Consolidates every order
// placed "yesterday" (Phnom Penh calendar day) between 1:30 PM and 11:59 PM,
// and sends the list to the staff Telegram group (GROUP_CHAT_ID) — the same
// group that already gets individual order/payment notifications.
//
// Orders are read from Redis (order:* — 14-day TTL, see order.js), so this
// only works if the cron actually runs within a day or so of the window it's
// summarizing; a missed run more than ~13 days late would find the
// underlying order records already expired.
import getClient from './_redis.js';
import { addDaysToDateStr, todayInPhnomPenh, formatDailySummaryMessage } from './_format.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
  if (!BOT_TOKEN || !GROUP_CHAT_ID) {
    console.error('Missing BOT_TOKEN or GROUP_CHAT_ID environment variable');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for daily order summary', err);
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  // This cron fires at 6:30 AM Cambodia time — the day being summarized is
  // always "yesterday" relative to right now.
  const targetDate = addDaysToDateStr(todayInPhnomPenh(), -1);
  // 1:30 PM–11:59:59 PM ICT (UTC+7) == 06:30:00–16:59:59 UTC the same
  // calendar date, since Cambodia has no DST.
  const windowStart = new Date(`${targetDate}T06:30:00.000Z`).getTime();
  const windowEnd = new Date(`${targetDate}T16:59:59.999Z`).getTime();

  const matched = [];
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try {
        order = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      const ts = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
      if (!isNaN(ts) && ts >= windowStart && ts <= windowEnd) {
        matched.push(order);
      }
    }
  } catch (err) {
    console.error('Redis scan failed for daily order summary', err);
    return res.status(500).json({ ok: false, error: 'Scan failed' });
  }

  matched.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const message = formatDailySummaryMessage(matched, targetDate);
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
    const tgData = await tgRes.json();
    if (!tgRes.ok || !tgData.ok) {
      console.error('Daily summary send failed', tgData);
      return res.status(502).json({ ok: false, error: 'Failed to send summary to group' });
    }
  } catch (err) {
    console.error('Daily summary send error', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  return res.status(200).json({ ok: true, date: targetDate, count: matched.length });
}
