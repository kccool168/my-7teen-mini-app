import getClient from './_redis.js';
import { pushStatusToSheet } from './_sheets.js';

const STAMPS_NEEDED = 6;

export default async function handler(req, res) {
  const action = String((req.query && req.query.action) || '');
  let client;
  try { client = await getClient(); } catch (err) { return res.status(500).json({ ok: false, error: 'db' }); }

  if (action === 'get') {
    const code2 = String((req.query && req.query.code) || '');
    const raw = await client.get('order:' + code2);
    if (!raw) return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(200).json({ ok: true, order: JSON.parse(raw) });
  }

  if (action === 'stamps') {
    const userId = String((req.query && req.query.userId) || '');
    const [totalStr, usedStr, lastPriceStr] = await Promise.all([
      client.get('user:' + userId + ':total'),
      client.get('user:' + userId + ':used'),
      client.get('user:' + userId + ':lastPrice'),
    ]);
    const total = parseInt(totalStr || '0', 10) || 0;
    const used = parseInt(usedStr || '0', 10) || 0;
    const stamps = total % STAMPS_NEEDED;
    const freeCups = Math.max(0, Math.floor(total / STAMPS_NEEDED) - used);
    return res.status(200).json({ ok: true, total, used, stamps, freeCups, lastCupPrice: lastPriceStr != null ? parseFloat(lastPriceStr) : null });
  }

  if (action === 'updateSub') {
    const code2 = String((req.query && req.query.code) || '');
    const dates = String((req.query && req.query.dates) || '').split(',').filter(Boolean);
    const start = String((req.query && req.query.start) || '');
    const validUntil = String((req.query && req.query.validUntil) || '');
    const dow = String((req.query && req.query.dow) || '');
    const key = 'order:' + code2;
    const raw = await client.get(key);
    if (!raw) return res.status(404).json({ ok: false, error: 'not found' });
    const order = JSON.parse(raw);
    order.subDates = dates;
    order.subStartDate = start;
    order.subValidUntil = validUntil;
    if (dow) order.subDaysOfWeek = dow.split(',').map(Number);
    const ttl = await client.ttl(key);
    const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
    await client.set(key, JSON.stringify(order), setOpts);
    await client.sAdd('active_subscriptions', code2);
    try { await pushStatusToSheet(code2, order.status, order.confirmedByName, { subValidUntil: order.subValidUntil }); } catch (e) {}
    return res.status(200).json({ ok: true, order });
  }

  if (action === 'redeem') {
    const code2 = String((req.query && req.query.code) || '');
    const userId = String((req.query && req.query.userId) || '');
    const key = 'order:' + code2;
    const raw = await client.get(key);
    if (!raw) return res.status(404).json({ ok: false, error: 'not found' });
    const order = JSON.parse(raw);
    const item = order.items && order.items[0];
    const unit = item ? Number(item.unitPrice) || 0 : 0;
    const lastPriceStr = await client.get('user:' + userId + ':lastPrice');
    const cap = lastPriceStr != null ? parseFloat(lastPriceStr) : unit;
    const discount = Math.min(unit, cap, 1.75);
    order.redeemedFreeCup = true;
    order.discount = discount;
    order.total = Math.max(0, Math.round(((order.subtotal != null ? order.subtotal : unit) - discount) * 100) / 100);
    const ttl = await client.ttl(key);
    const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
    await client.set(key, JSON.stringify(order), setOpts);
    // This order already added a stamp for every cup in it when it was first
    // created (api/order.js credits stamps at order time, not at payment
    // time) -- since it's being converted to a free-cup redemption after the
    // fact, undo that stamp so it doesn't double count, then spend the cup.
    const cupsInOrder = (order.items || []).reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
    const totalKey = 'user:' + userId + ':total';
    const usedKey = 'user:' + userId + ':used';
    const newTotal = await client.decrBy(totalKey, cupsInOrder);
    const newUsed = await client.incr(usedKey);
    const newStamps = ((newTotal % STAMPS_NEEDED) + STAMPS_NEEDED) % STAMPS_NEEDED;
    const newFreeCups = Math.max(0, Math.floor(newTotal / STAMPS_NEEDED) - newUsed);
    try { await pushStatusToSheet(code2, order.status, order.confirmedByName); } catch (e) {}
    return res.status(200).json({ ok: true, order, newTotal, newUsed, newStamps, newFreeCups });
  }

  return res.status(400).json({ ok: false, error: 'unknown action' });
}
