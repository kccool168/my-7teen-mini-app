// Vercel serverless function: POST /api/order
//
// Called by the Mini App when a customer taps "I've Paid". It:
//  1. Atomically updates the customer's loyalty stamp count in Redis
//     (keyed by their Telegram user id), so stamps persist across visits.
//  2. Caps any redeemed "free cup" reward to the price of the customer's
//     most recent order (so someone who usually orders a $1.25 cup can't
//     redeem a $1.75 item for free) — computed and enforced server-side,
//     never trusted from the client. The cap is persisted so future
//     redemptions stay accurate.
//  3. Sends an order receipt directly to the customer's Telegram chat.
//  4. Sends the shop's order report (including any customer remark) to the
//     staff Telegram group, with "Mark Paid" / "Not Received" buttons.
//     The order is stored in Redis (14-day TTL) so those button taps —
//     handled by api/telegram-webhook.js — can look it up and edit this
//     same message with the confirmed status.
import getClient from './_redis.js';
import { formatGroupMessage, formatReceiptMessage, groupKeyboard } from './_format.js';

const STAMPS_NEEDED = 6;
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

  if (!BOT_TOKEN || !GROUP_CHAT_ID) {
    console.error('Missing BOT_TOKEN or GROUP_CHAT_ID environment variable');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let order;
  try {
    order = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    return res.status(400).json({ ok: false, error: 'Order must include at least one item' });
  }

  // Customer's optional note, capped to 50 chars regardless of what the
  // client sent.
  const remark = typeof order.remark === 'string' ? order.remark.trim().slice(0, 50) : '';

  // ---- 1. Persist loyalty stamps + resolve the redeemed reward (best-effort;
  //         order still succeeds if Redis is unavailable) ----
  let stamps = 0;
  let freeCups = 0;
  let appliedDiscount = 0;
  let appliedTotal = Number(order.subtotal) || 0;
  let lastCupPrice = null;
  let redeemApplied = false;
  let redisClient = null;
  const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;

  if (userId) {
    try {
      const client = await getClient();
      redisClient = client;
      const totalKey = `user:${userId}:total`;
      const usedKey = `user:${userId}:used`;
      const lastPriceKey = `user:${userId}:lastPrice`;
      const cupsInOrder = order.items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
      const subtotal = Number(order.subtotal) || 0;

      const [totalStr, usedStr, lastPriceStr] = await Promise.all([
        client.get(totalKey), client.get(usedKey), client.get(lastPriceKey),
      ]);
      const priorTotal = parseInt(totalStr || '0', 10) || 0;
      const priorUsed = parseInt(usedStr || '0', 10) || 0;
      const priorAvailable = Math.max(0, Math.floor(priorTotal / STAMPS_NEEDED) - priorUsed);
      const priorLastCupPrice = lastPriceStr != null ? parseFloat(lastPriceStr) : null;

      // Redemption is only honored if the account actually has a free cup
      // banked server-side — never trust the client's redeemedFreeCup flag
      // alone. The discount amount is computed here too, capped to the
      // price of the customer's last order (not whatever the client sent).
      if (order.redeemedFreeCup && priorAvailable > 0) {
        redeemApplied = true;
        await client.incr(usedKey);
      }

      if (redeemApplied) {
        const maxUnitPrice = order.items.reduce((max, item) => Math.max(max, Number(item.unitPrice) || 0), 0);
        appliedDiscount = (priorLastCupPrice != null && !isNaN(priorLastCupPrice))
          ? Math.min(maxUnitPrice, priorLastCupPrice)
          : maxUnitPrice;
      }
      appliedTotal = Math.max(0, subtotal - appliedDiscount);

      const newTotal = await client.incrBy(totalKey, cupsInOrder);
      const usedStr2 = await client.get(usedKey);
      const used2 = parseInt(usedStr2 || '0', 10) || 0;
      stamps = newTotal % STAMPS_NEEDED;
      freeCups = Math.max(0, Math.floor(newTotal / STAMPS_NEEDED) - used2);

      // Record this order's price-per-cup as the cap for the *next*
      // redemption.
      if (cupsInOrder > 0) {
        const pricePerCup = subtotal / cupsInOrder;
        await client.set(lastPriceKey, pricePerCup.toFixed(2));
        lastCupPrice = Math.round(pricePerCup * 100) / 100;
      }
    } catch (err) {
      console.error('Stamp persistence failed', err);
    }
  }

  const resolvedOrder = Object.assign({}, order, {
    discount: appliedDiscount, total: appliedTotal, remark, redeemedFreeCup: redeemApplied,
    status: 'pending', confirmedByName: null,
  });

  // ---- 2. Send receipt to the customer ----
  let customerNotified = false;
  if (userId) {
    try {
      const receiptMessage = formatReceiptMessage(resolvedOrder, stamps, freeCups, STAMPS_NEEDED);
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text: receiptMessage, parse_mode: 'HTML' }),
      });
      const tgData = await tgRes.json();
      customerNotified = !!(tgRes.ok && tgData.ok);
      if (!customerNotified) console.error('Customer receipt failed', tgData);
    } catch (err) {
      console.error('Customer receipt error', err);
    }
  }

  // ---- 3. Send report to the staff group, with Mark Paid / Not Received
  //         buttons, and remember it in Redis so the webhook can edit it. ----
  let groupNotified = false;
  try {
    const groupMessage = formatGroupMessage(resolvedOrder);
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_CHAT_ID, text: groupMessage, parse_mode: 'HTML',
        reply_markup: groupKeyboard(resolvedOrder.orderCode, 'pending'),
      }),
    });
    const tgData = await tgRes.json();
    groupNotified = !!(tgRes.ok && tgData.ok);
    if (!groupNotified) {
      console.error('Group notify failed', tgData);
      return res.status(502).json({ ok: false, error: 'Failed to notify group' });
    }

    const messageId = tgData.result && tgData.result.message_id;
    if (messageId != null && resolvedOrder.orderCode) {
      try {
        const client = redisClient || (await getClient());
        const orderRecord = Object.assign({}, resolvedOrder, {
          chatId: GROUP_CHAT_ID, messageId, confirmedByName: null, confirmedAt: null, bankRef: null, bankPayer: null,
        });
        await client.set(`order:${resolvedOrder.orderCode}`, JSON.stringify(orderRecord), { EX: ORDER_TTL_SECONDS });
        // Index this order as "still awaiting payment" so the bank-notification
        // matcher (api/telegram-webhook.js) can scan only open orders instead
        // of every order ever placed. Entries are removed once resolved.
        await client.sAdd('pending_orders', resolvedOrder.orderCode);
      } catch (err) {
        console.error('Order status persistence failed (buttons will not work for this order)', err);
      }
    }
  } catch (err) {
    console.error('Group notify error', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  return res.status(200).json({
    ok: true, stamps, freeCups, customerNotified, groupNotified,
    discount: appliedDiscount, total: appliedTotal, lastCupPrice,
  });
}
