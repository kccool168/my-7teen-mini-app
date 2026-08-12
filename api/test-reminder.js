// Vercel serverless function: GET /api/test-reminder
//
// One-off diagnostic: sends the exact order-reminder DM text straight to a
// single hardcoded Telegram username, so staff can confirm the reminder
// message actually lands in a real chat before trusting the 5:30 PM cron.
// Not referenced by any cron -- call it directly in a browser to fire a
// single test DM. Safe to delete once the reminder feature is verified.
import getClient from './_redis.js';

const TARGET_USERNAME = 'RatanaKIN';
const REMINDER_TEXT = "Hey! Just a friendly reminder from 7Teen Cafe -- looks like you haven't ordered yet today. Don't miss out on your coffee. Order now before we close!";

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
          return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

  let client;
    try {
          client = await getClient();
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Database unavailable' });
    }

  let targetId = null;
    let scanned = 0;
    try {
          for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
                  const raw = await client.get(key);
                  if (!raw) continue;
                  let order;
                  try { order = JSON.parse(raw); } catch (e) { continue; }
                  scanned++;
                  const uname = order.customer && order.customer.username ? String(order.customer.username) : '';
                  if (uname.toLowerCase() === TARGET_USERNAME.toLowerCase()) {
                            targetId = order.customer.id != null ? String(order.customer.id) : null;
                            if (targetId) break;
                  }
          }
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Scan failed', details: String(err) });
    }

  if (!targetId) {
        return res.status(404).json({ ok: false, error: `No order record found for username ${TARGET_USERNAME}`, scanned });
  }

  let sent = false;
    let tgData = null;
    try {
          const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: targetId, text: REMINDER_TEXT }),
          });
          tgData = await tgRes.json();
          sent = !!(tgRes.ok && tgData.ok);
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Telegram send failed', details: String(err) });
    }

  return res.status(200).json({ ok: true, targetId, sent, tgData });
}
