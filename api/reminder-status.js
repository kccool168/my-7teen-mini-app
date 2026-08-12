// Vercel serverless function: GET /api/reminder-status
//
// Read-only diagnostic: recomputes the exact same known/active-subscriber/
// already-ordered-since-1pm sets that api/order-reminder.js uses, but never
// sends any Telegram messages. Lets staff confirm after the fact who would
// have been (or was) reminded, without re-firing real DMs. Safe to call as
// many times as needed. Delete once no longer needed.
import getClient from './_redis.js';
import { todayInPhnomPenh } from './_format.js';

export default async function handler(req, res) {
    let client;
    try {
          client = await getClient();
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Database unavailable' });
    }

  const activeSubUsers = new Set();
    try {
          const subCodes = await client.sMembers('active_subscriptions');
          for (const code of subCodes) {
                  const raw = await client.get(`order:${code}`);
                  if (!raw) continue;
                  let order;
                  try { order = JSON.parse(raw); } catch (e) { continue; }
                  const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
                  if (userId) activeSubUsers.add(userId);
          }
    } catch (err) {
          return res.status(500).json({ ok: false, error: 'Failed to resolve active subscribers' });
    }

  const today = todayInPhnomPenh();
    const windowStart = new Date(`${today}T06:00:00.000Z`).getTime();
    const now = Date.now();

  const knownUsers = new Map();
    const orderedSince1pm = new Set();

  try {
        for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
                const raw = await client.get(key);
                if (!raw) continue;
                let order;
                try { order = JSON.parse(raw); } catch (e) { continue; }
                const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
                if (!userId) continue;

          const uname = order.customer && order.customer.username ? String(order.customer.username) : null;
                knownUsers.set(userId, uname);
                if (order.orderType === 'subscription') continue;

          const ts = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
                if (!isNaN(ts) && ts >= windowStart && ts <= now) {
                          orderedSince1pm.add(userId);
                }
        }
  } catch (err) {
        return res.status(500).json({ ok: false, error: 'Scan failed' });
  }

  const eligible = [];
    for (const [userId, uname] of knownUsers.entries()) {
          if (activeSubUsers.has(userId) || orderedSince1pm.has(userId)) continue;
          eligible.push({ userId, username: uname });
    }

  return res.status(200).json({
        ok: true,
        knownUsers: knownUsers.size,
        activeSubscribers: activeSubUsers.size,
        orderedSince1pm: orderedSince1pm.size,
        eligibleCount: eligible.length,
        eligible,
  });
}
