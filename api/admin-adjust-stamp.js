// Vercel serverless function: POST /api/admin-adjust-stamp
//
// Manually adjusts a customer's loyalty stamp count by their Telegram
// @username, and notifies the customer directly via the bot. Intended for
// the shop owner to top up or correct a customer's stamps outside the
// normal order flow. Stamps are stored keyed by numeric Telegram user id,
// so this resolves the username against existing order records in Redis
// (same lookup api/order-reminder.js uses) -- it only works for customers
// who have placed at least one order through the bot in the last 14 days
// (order records expire after that). Order records only ever capture the
// customer's Telegram id and @username, never their display name, so
// lookups must be done by username.
//
// Protected the same way as the other admin/cron endpoints: if CRON_SECRET
// is set, callers must send it as a Bearer token.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const usernameRaw = body && body.username;
  const notifyOnly = !!(body && body.notifyOnly);
  const delta = body && Number.isFinite(Number(body.delta)) ? Math.trunc(Number(body.delta)) : null;
  if (!notifyOnly && (delta === null || delta === 0)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid delta (non-zero integer)' });
  }
  const effectiveDelta = delta === null ? 0 : delta;

  const username = usernameRaw && typeof usernameRaw === 'string'
    ? usernameRaw.replace(/^@/, '').trim().toLowerCase()
    : null;
  if (!username) {
    return res.status(400).json({ ok: false, error: 'Provide a username' });
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for admin-adjust-stamp', err);
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  let userId = null;
  let matchedUsername = null;
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const c = order.customer || {};
      const uid = c.id != null ? String(c.id) : null;
      if (!uid) continue;
      const uname = c.username ? String(c.username).toLowerCase() : null;
      if (uname === username) {
        userId = uid;
        matchedUsername = c.username || null;
        break;
      }
    }
  } catch (err) {
    console.error('Redis scan failed for admin-adjust-stamp', err);
    return res.status(500).json({ ok: false, error: 'Lookup failed' });
  }

  if (!userId) {
    return res.status(404).json({
      ok: false,
      error: `No order history found for @${username} -- can't resolve their Telegram id. They need to have placed at least one order through the bot in the last 14 days.`,
    });
  }

  let stamps, freeCups, finalTotal;
  try {
    const totalKey = `user:${userId}:total`;
    const usedKey = `user:${userId}:used`;
    const newTotal = notifyOnly
      ? (parseInt((await client.get(totalKey)) || '0', 10) || 0)
      : await client.incrBy(totalKey, effectiveDelta);
    if (newTotal < 0) {
      await client.set(totalKey, '0');
      finalTotal = 0;
    } else {
      finalTotal = newTotal;
    }
    const usedStr = await client.get(usedKey);
    const used = parseInt(usedStr || '0', 10) || 0;
    stamps = finalTotal % STAMPS_NEEDED;
    freeCups = Math.max(0, Math.floor(finalTotal / STAMPS_NEEDED) - used);
  } catch (err) {
    console.error('Stamp adjustment failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  let customerNotified = false;
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (BOT_TOKEN) {
    try {
      const changeLine = notifyOnly
        ? `Here's your current loyalty status at 7Teen Cafe:`
        : (effectiveDelta > 0
          ? `You just earned +${effectiveDelta} stamp${effectiveDelta === 1 ? '' : 's'} at 7Teen Cafe!`
          : `Your stamp balance was adjusted by ${effectiveDelta} at 7Teen Cafe.`);
      const freeCupLine = freeCups > 0
        ? `\\n\\nYou have ${freeCups} free cup${freeCups === 1 ? '' : 's'} ready to redeem!`
        : '';
      const text = `Hey there! ${changeLine}\\n\\n☕ Stamps: ${stamps}/${STAMPS_NEEDED}${freeCupLine}`;
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text: text }),
      });
      const tgData = await tgRes.json();
      customerNotified = !!(tgRes.ok && tgData.ok);
      if (!customerNotified) console.error('Stamp adjustment customer notify failed', tgData);
    } catch (err) {
      console.error('Stamp adjustment customer notify error', err);
    }
  }

  return res.status(200).json({
    ok: true, userId, username: matchedUsername, delta: effectiveDelta, notifyOnly, total: finalTotal, stamps, freeCups, customerNotified,
  });
}
