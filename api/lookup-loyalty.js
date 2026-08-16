// TEMPORARY one-off: GET /api/lookup-loyalty
// Looks up a customer's Redis loyalty counters by Telegram username and
// pushes them into the Loyalty Google Sheet tab via pushLoyaltyToSheet.
// Delete this file once no longer needed.
import getClient from './_redis.js';
import { pushLoyaltyToSheet } from './_sheets.js';

const STAMPS_NEEDED = 6;
const TARGET_USERNAME = 'hrithyseth';

export default async function handler(req, res) {
  let client;
  try {
    client = await getClient();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Database unavailable' });
  }

let found = null;
  try {
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      const raw = await client.get(key);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const uname = order.customer && order.customer.username ? String(order.customer.username).toLowerCase() : '';
      if (uname === TARGET_USERNAME) { found = order.customer; break; }
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Scan failed', details: String(err) });
  }

if (!found || found.id == null) {
  return res.status(404).json({ ok: false, error: 'No order found for that username' });
}

const userId = String(found.id);
  const totalKey = `user:${userId}:total`;
  const usedKey = `user:${userId}:used`;
  const lastPriceKey = `user:${userId}:lastPrice`;
  const totalStr = await client.get(totalKey);
  const usedStr = await client.get(usedKey);
  const lastPriceStr = await client.get(lastPriceKey);
  const total = parseInt(totalStr || '0', 10) || 0;
  const used = parseInt(usedStr || '0', 10) || 0;
  const stamps = total % STAMPS_NEEDED;
  const freeCups = Math.max(0, Math.floor(total / STAMPS_NEEDED) - used);
  const lastCupPrice = lastPriceStr != null ? parseFloat(lastPriceStr) : null;

await pushLoyaltyToSheet(found, stamps, freeCups, lastCupPrice);

return res.status(200).json({ ok: true, customer: found, total, used, stamps, freeCups, lastCupPrice });
}
