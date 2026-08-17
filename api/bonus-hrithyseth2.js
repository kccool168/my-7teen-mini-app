import getClient from './_redis.js';
import { pushLoyaltyToSheet } from './_sheets.js';

const STAMPS_NEEDED = 6;
const CUSTOMER_ID = '1330188021';
const CUSTOMER = { id: 1330188021, firstName: 'Rithyseth', lastName: '', username: 'HRithyseth' };

export default async function handler(req, res) {
  try {
    const client = await getClient();
    const totalKey = `user:${CUSTOMER_ID}:total`;
    const usedKey = `user:${CUSTOMER_ID}:used`;
    const priceKey = `user:${CUSTOMER_ID}:lastPrice`;

  const before = parseInt((await client.get(totalKey)) || '0', 10);
    const after = before + 2;
    await client.set(totalKey, String(after));

  const used = parseInt((await client.get(usedKey)) || '0', 10);
    const lastPrice = parseFloat((await client.get(priceKey)) || '0');

  const stamps = after % STAMPS_NEEDED;
    const freeCups = Math.max(0, Math.floor(after / STAMPS_NEEDED) - used);

  await pushLoyaltyToSheet(CUSTOMER, stamps, freeCups, lastPrice);

  res.status(200).json({ ok: true, before, after, used, stamps, freeCups, lastPrice });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
