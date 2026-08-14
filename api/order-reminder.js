// Vercel serverless function: GET /api/order-reminder
//
// Runs once a day via Vercel Cron at 8:00 PM Cambodia time (13:00 UTC).
// DMs every known customer who hasn't placed a regular order yet today
// since 1:00 PM Cambodia time -- a friendly nudge in case they missed
// ordering. Customers with a currently active paid subscription are always
// skipped, since their cup is already scheduled automatically and they
// don't need a reminder.
//
// "Known customers" = anyone with an order record still in Redis (14-day
// TTL, see order.js) -- a rolling proxy for "people who've ordered from us
// recently," the same source of truth the daily order summary and
// subscription expiry check already rely on.
import getClient from './_redis.js';
import { todayInPhnomPenh } from './_format.js';

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
      if (!BOT_TOKEN) {
              console.error('Missing BOT_TOKEN environment variable');
              return res.status(500).json({ ok: false, error: 'Server not configured' });
      }
      // Optional -- if set, a one-line run summary is posted to the staff group
      // after each run so staff can see at a glance whether it fired and how
      // many people were reminded, without digging into Vercel logs.
      const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

        // Temporarily paused for 14-15 Aug 2026 -- remove this block once the
        // pause is no longer needed.
        const PAUSED_DATES = ['2026-08-14', '2026-08-15'];
        if (PAUSED_DATES.includes(todayInPhnomPenh())) {
                  console.log(`Order reminder paused for ${todayInPhnomPenh()} -- skipping run.`);
                  return res.status(200).json({ ok: true, paused: true, date: todayInPhnomPenh() });
        }
      
      let client;
      try {
              client = await getClient();
      } catch (err) {
              console.error('Redis unavailable for order reminder', err);
              return res.status(500).json({ ok: false, error: 'Database unavailable' });
      }

      // Customers with a currently active paid subscription already have a cup
      // scheduled automatically -- never remind them.
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
              console.error('Failed to resolve active subscribers for reminder exclusion', err);
      }

      const today = todayInPhnomPenh();
      // 1:00 PM Cambodia time today == 06:00 UTC today (Cambodia has no DST).
      const windowStart = new Date(`${today}T06:00:00.000Z`).getTime();
      const now = Date.now();

      const knownUsers = new Set();
      const orderedSince1pm = new Set();

      try {
              for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
                        const raw = await client.get(key);
                        if (!raw) continue;
                        let order;
                        try { order = JSON.parse(raw); } catch (e) { continue; }
                        const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
                        if (!userId) continue;

                        knownUsers.add(userId);
                        if (order.orderType === 'subscription') continue; // handled via activeSubUsers above

                        const ts = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
                        if (!isNaN(ts) && ts >= windowStart && ts <= now) {
                                    orderedSince1pm.add(userId);
                        }
              }
      } catch (err) {
              console.error('Redis scan failed for order reminder', err);
              return res.status(500).json({ ok: false, error: 'Scan failed' });
      }

        const REMINDER_TEXT = "Hey MoyMoy! Just a friendly reminder from 7Teen Cafe -- looks like you haven't ordered yet for tmr. Don't miss out on your coffee. Order Now!";

      let reminded = 0;
      let skipped = 0;
      for (const userId of knownUsers) {
              if (activeSubUsers.has(userId) || orderedSince1pm.has(userId)) {
                        skipped++;
                        continue;
              }
              try {
                        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: userId, text: REMINDER_TEXT }),
                        });
                        const tgData = await tgRes.json();
                        if (tgRes.ok && tgData.ok) reminded++;
                        else console.error(`Reminder failed for user ${userId}`, tgData);
              } catch (err) {
                        console.error(`Reminder error for user ${userId}`, err);
              }
      }

      // Post a short run summary to the staff group (best-effort -- never
      // blocks or fails the run itself).
      if (GROUP_CHAT_ID) {
              const summary = `Order reminder run\nKnown customers: ${knownUsers.size}\nActive subscribers (skipped): ${activeSubUsers.size}\nAlready ordered since 1PM (skipped): ${orderedSince1pm.size}\nReminded: ${reminded}`;
              try {
                        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text: summary }),
                        });
              } catch (err) {
                        console.error('Order reminder summary post failed', err);
              }
      }

      return res.status(200).json({
              ok: true, knownUsers: knownUsers.size, activeSubscribers: activeSubUsers.size, reminded, skipped,
      });
}

