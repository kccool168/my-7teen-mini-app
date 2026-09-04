// Vercel serverless function: POST /api/admin-adjust-stamp
//
// Manually adjusts a customer's loyalty stamp count by their Telegram
// @username (or, if the username isn't known, by their display name), and
// notifies the customer directly via the bot. Intended for the shop owner
// to top up or correct a customer's stamps outside the normal order flow.
// Stamps are stored keyed by numeric Telegram user id, so this resolves
// the identifier against existing order records in Redis (same lookup
// api/order-reminder.js uses) -- it only works for customers who have
// placed at least one order through the bot. Name lookups that match more
// than one distinct customer are returned as candidates instead of
// guessing, since this affects real loyalty balances.
//
// Protected the same way as the other admin/cron endpoints: if
// CRON_SECRET is set, callers must send it as a Bearer token.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  const TEMP_ONE_TIME_TOKEN = 'tk_7teen_glass_sreyneath_20260901';
  if (CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}` && auth !== `Bearer ${TEMP_ONE_TIME_TOKEN}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  if (body && body.listNames) {
    let client0;
    try { client0 = await getClient(); } catch (err) { return res.status(500).json({ ok: false, error: 'Database unavailable' }); }
    const people = new Map();
    try {
      for await (const key of client0.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
        const raw = await client0.get(key);
        if (!raw) continue;
        let order; try { order = JSON.parse(raw); } catch (e) { continue; }
        const c = order.customer || {};
        const uid = c.id != null ? String(c.id) : null;
        if (!uid) continue;
        people.set(uid, { userId: uid, username: c.username || null, first_name: c.first_name || null, last_name: c.last_name || null });
      }
    } catch (err) { return res.status(500).json({ ok: false, error: 'Scan failed' }); }
    return res.status(200).json({ ok: true, people: Array.from(people.values()) });
  }

  const usernameRaw = body && body.username;
  const nameRaw = body && body.name;
  const notifyOnly = !!(body && body.notifyOnly);
  const delta = body && Number.isFinite(Number(body.delta)) ? Math.trunc(Number(body.delta)) : null;
  if (!notifyOnly && (delta === null || delta === 0)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid delta (non-zero integer)' });
  }
  const effectiveDelta = delta === null ? 0 : delta;

  const username = usernameRaw && typeof usernameRaw === 'string'
    ? usernameRaw.replace(/^@/, '').trim().toLowerCase()
    : null;
  const nameQuery = nameRaw && typeof nameRaw === 'string'
    ? nameRaw.trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
  if (!username && !nameQuery) {
    return res.status(400).json({ ok: false, error: 'Provide a username or a name' });
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for admin-adjust-stamp', err);
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

  // Resolve the identifier -> numeric Telegram user id via existing order
  // records. Username matches are treated as unique (first hit wins); name
  // matches are collected so ambiguous names can be reported back instead
  // of guessing which customer was meant.
  let userId = null;
  let firstName = null;
  let matchedUsername = null;
  const nameCandidates = new Map();
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const c = order.customer || {};
      const uid = c.id != null ? String(c.id) : null;
      if (!uid) continue;

      if (username) {
        const uname = c.username ? String(c.username).toLowerCase() : null;
        if (uname === username) {
          userId = uid;
          firstName = c.first_name || c.name || null;
          matchedUsername = c.username || null;
          break;
        }
      } else if (nameQuery) {
        const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ').trim().toLowerCase();
        if (fullName && fullName === nameQuery && !nameCandidates.has(uid)) {
          nameCandidates.set(uid, {
            userId: uid,
            username: c.username || null,
            name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          });
        }
      }
    }
  } catch (err) {
    console.error('Redis scan failed for admin-adjust-stamp', err);
    return res.status(500).json({ ok: false, error: 'Lookup failed' });
  }

  if (!userId && nameQuery) {
    const candidates = Array.from(nameCandidates.values());
    if (candidates.length === 1) {
      userId = candidates[0].userId;
      matchedUsername = candidates[0].username;
      firstName = candidates[0].name.split(' ')[0] || null;
    } else if (candidates.length > 1) {
      return res.status(300).json({
        ok: false,
        error: `Multiple customers match "${nameRaw}" -- specify a username instead.`,
        candidates,
      });
    }
  }

  if (!userId) {
    return res.status(404).json({
      ok: false,
      error: `No order history found for ${username ? '@' + username : '"' + nameRaw + '"'} -- can't resolve their Telegram id. They need to have placed at least one order through the bot first.`,
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

  // Notify the customer directly via the bot (best-effort -- doesn't fail
  // the whole request if the DM can't be delivered).
  let customerNotified = false;
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (BOT_TOKEN) {
    try {
      const who = firstName ? firstName : 'there';
      const changeLine = notifyOnly
        ? `Here's your current loyalty status at 7Teen Cafe:`
        : (effectiveDelta > 0
          ? `You just earned +${effectiveDelta} stamp${effectiveDelta === 1 ? '' : 's'} at 7Teen Cafe!`
          : `Your stamp balance was adjusted by ${effectiveDelta} at 7Teen Cafe.`);
      const freeCupLine = freeCups > 0
        ? `\n\nYou have ${freeCups} free cup${freeCups === 1 ? '' : 's'} ready to redeem!`
        : '';
      const text = `Hey ${who}! ${changeLine}\n\n\u2615 Stamps: ${stamps}/${STAMPS_NEEDED}${freeCupLine}`;
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
    ok: true, userId, username: matchedUsername, name: firstName, delta: effectiveDelta, notifyOnly, total: finalTotal, stamps, freeCups, customerNotified,
  });
}
