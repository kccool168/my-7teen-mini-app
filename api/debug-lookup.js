import getClient from './_redis.js';
import { pushStatusToSheet } from './_sheets.js';

export default async function handler(req, res) {
  const code = String((req.query && req.query.code) || '');
  const addDate = String((req.query && req.query.date) || '');
  if (!code || !addDate) return res.status(400).json({ ok: false, error: 'Missing code or date' });
  let client;
  try { client = await getClient(); } catch (err) { return res.status(500).json({ ok: false, error: 'db' }); }
  const key = `order:${code}`;
  const raw = await client.get(key);
  if (!raw) return res.status(404).json({ ok: false, error: 'not found' });
  let order;
  try { order = JSON.parse(raw); } catch (e) { return res.status(500).json({ ok: false, error: 'corrupt' }); }
  const dates = Array.isArray(order.subDates) ? order.subDates.slice() : [];
  if (dates.indexOf(addDate) === -1) {
    dates.push(addDate);
    dates.sort();
  }
  order.subDates = dates;
  order.subValidUntil = dates[dates.length - 1];
  const ttl = await client.ttl(key);
  const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
  await client.set(key, JSON.stringify(order), setOpts);
  await client.sAdd('active_subscriptions', code);
  try {
    await pushStatusToSheet(code, order.status, order.confirmedByName, { subValidUntil: order.subValidUntil });
  } catch (e) {}
  return res.status(200).json({ ok: true, orderCode: code, subDates: order.subDates, subValidUntil: order.subValidUntil });
}
