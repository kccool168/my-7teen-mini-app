// Vercel serverless function: GET /api/admin-remove-subs
//
// One-off admin action: removes specific customers' order codes from the
// active_subscriptions Redis SET, so they stop being treated as "active
// subscribers" (they'll be included in reminder targeting again, and their
// subscription won't auto-schedule). Does NOT delete the underlying
// order:<code> records -- just the active-subscription membership. Never
// sends any Telegram messages. Delete this file once no longer needed.
import getClient from './_redis.js';

const TARGET_USERNAMES = ['RatanaKIN', 'phengnpaaueel', 'KR8889'].map((u) => u.toLowerCase());

export default async function handler(req, res) {
    let client;
    try {
          client = await getClient();
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Database unavailable' });
    }

  const removed = [];
    const kept = [];
    try {
          const subCodes = await client.sMembers('active_subscriptions');
          for (const code of subCodes) {
                  const raw = await client.get(`order:${code}`);
                  if (!raw) continue;
                  let order;
                  try { order = JSON.parse(raw); } catch (e) { continue; }
                  const uname = order.customer && order.customer.username ? String(order.customer.username).toLowerCase() : '';
                  if (TARGET_USERNAMES.includes(uname)) {
                            await client.sRem('active_subscriptions', code);
                            removed.push({ orderCode: code, username: order.customer.username });
                  } else {
                            kept.push(code);
                  }
          }
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Failed to process', details: String(err) });
    }

  return res.status(200).json({ ok: true, removedCount: removed.length, removed, remainingCount: kept.length });
}
