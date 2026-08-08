// Vercel serverless function: POST /api/order
//
// Called by the Mini App when a customer taps "I've Paid". Handles two order
// types:
//
//  - Regular cart orders (orderType omitted / 'single'): unchanged from
//    before — stamps, free-cup redemption cap, group + customer receipt.
//  - Subscription orders (orderType: 'subscription'): a single fixed drink
//    for N consecutive days (max 6, Sundays never count) starting on a
//    chosen date. The total is unit price × paid days, recomputed
//    server-side from the start date and day count so the client can't
//    tamper with the date range or price. If the customer has an eligible
//    loyalty free cup banked, it's auto-applied as one bonus (unpaid) day
//    on top of the paid days — mirrors the free-cup mechanic used for
//    regular cart orders, just applied automatically instead of a toggle.
//
// Both types:
//  1. Send an order/subscription receipt directly to the customer's
//     Telegram chat, and remember that message's id so later status changes
//     (api/telegram-webhook.js) can edit it in place.
//  2. Send the shop's report to the staff Telegram group, with inline
//     buttons ("Mark Paid"/"Not Received", plus "Redeem Today" once a
//     subscription is paid). The order is stored in Redis (14-day TTL) so
//     those button taps can look it up and edit both messages.
import getClient from './_redis.js';
import { formatGroupMessage, formatReceiptMessage, groupKeyboard, computeSubDates, clampSubStartDate, todayInPhnomPenh } from './_format.js';
import { pushOrderToSheet } from './_sheets.js';

const STAMPS_NEEDED = 6;
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const MAX_SUB_DAYS = 6;
// The café is always closed Sundays, so 0 is never a valid choice — the
// customer picks any non-empty subset of the remaining six days.
const VALID_SUB_DOWS = [1, 2, 3, 4, 5, 6];

// Server-side unique order code generator (7T-1000, 7T-1001, ...), backed by
// a single atomic Redis counter (INCR) so concurrent orders can never
// collide — unlike the old client-side Math.random() scheme, which could in
// theory repeat. The seed is written once via SETNX comfortably above the
// old random range so new codes never overlap with any order still live
// from before this change.
async function generateOrderCode(client) {
  await client.set('order_seq', '999', { NX: true });
  const n = await client.incr('order_seq');
  return `7T-${n}`;
}

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

  const isSubscription = order.orderType === 'subscription';

  // Customer's optional note, capped to 50 chars regardless of what the
  // client sent.
  const remark = typeof order.remark === 'string' ? order.remark.trim().slice(0, 50) : '';

  let resolvedOrder;
  let stamps = 0;
  let freeCups = 0;
  let appliedDiscount = 0;
  let appliedTotal = Number(order.subtotal) || 0;
  let lastCupPrice = null;
  let redisClient = null;

  // ---- 0. Generate the unique, server-authoritative order code. Never
  //         trust anything the client sent for this — the old client-side
  //         Math.random() scheme is gone. Falls back to a timestamp-based
  //         code only if Redis itself is unreachable, so an order never
  //         fails outright just because the counter couldn't be read. ----
  let orderCode;
  try {
    redisClient = await getClient();
    orderCode = await generateOrderCode(redisClient);
  } catch (err) {
    console.error('Order code generation failed, using timestamp fallback', err);
    orderCode = `7T-${Date.now().toString().slice(-6)}`;
  }

  // Which day(s) of the week the customer wants their drink — validated
  // against the allowed range (Mon-Sat; the café is always closed Sundays)
  // and de-duped. Falls back to every open day if the client omitted it or
  // sent garbage, so an order never fails outright over a malformed list.
  const rawDaysOfWeek = Array.isArray(order.subDaysOfWeek) ? order.subDaysOfWeek : [];
  const cleanedDaysOfWeek = Array.from(new Set(
    rawDaysOfWeek.map((d) => parseInt(d, 10)).filter((d) => VALID_SUB_DOWS.indexOf(d) !== -1)
  ));
  const subDaysOfWeek = cleanedDaysOfWeek.length ? cleanedDaysOfWeek : VALID_SUB_DOWS.slice();

  if (isSubscription) {
    // ---- Subscription: recompute the date range + total server-side, never
    //      trust the client's total, date list, or day count. ----
    const item = order.items[0];
    const unitPrice = Number(item && item.unitPrice) || 0;
    const subDays = Math.max(1, Math.min(MAX_SUB_DAYS, parseInt(order.subDays, 10) || 0));
    const rawStartDate = typeof order.subStartDate === 'string' ? order.subStartDate : null;

    if (!rawStartDate || subDays < 1) {
      return res.status(400).json({ ok: false, error: 'Subscription must include a valid start date and day count' });
    }

    const today = todayInPhnomPenh();
    const subStartDate = clampSubStartDate(rawStartDate, today, subDaysOfWeek);

    // ---- Loyalty free-cup bonus: if the customer already has a free cup
    //      banked, it's auto-applied as 1 bonus (unpaid) day on top of the
    //      paid days — same Redis-backed balance used for regular cart
    //      orders, just applied automatically rather than via a toggle. ----
    let bonusDays = 0;
    let freeCupApplied = false;
    const subUserId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
    if (subUserId) {
      try {
        const client = redisClient || (await getClient());
        redisClient = client;
        const totalKey = `user:${subUserId}:total`;
        const usedKey = `user:${subUserId}:used`;
        const [totalStr, usedStr] = await Promise.all([client.get(totalKey), client.get(usedKey)]);
        const priorTotal = parseInt(totalStr || '0', 10) || 0;
        const priorUsed = parseInt(usedStr || '0', 10) || 0;
        const priorAvailable = Math.max(0, Math.floor(priorTotal / STAMPS_NEEDED) - priorUsed);
        stamps = priorTotal % STAMPS_NEEDED;
        if (priorAvailable > 0) {
          bonusDays = 1;
          freeCupApplied = true;
          await client.incr(usedKey);
          freeCups = Math.max(0, priorAvailable - 1);
        } else {
          freeCups = 0;
        }
      } catch (err) {
        console.error('Free-cup bonus lookup failed for subscription', err);
      }
    }

    const totalDays = subDays + bonusDays;
    const subDates = computeSubDates(subStartDate, totalDays, subDaysOfWeek);
    appliedTotal = Math.round(unitPrice * subDays * 100) / 100;

    resolvedOrder = Object.assign({}, order, {
      orderCode,
      orderType: 'subscription',
      items: [item],
      subtotal: appliedTotal, discount: 0, total: appliedTotal,
      redeemedFreeCup: freeCupApplied, remark,
      subStartDate, subDays, subDaysOfWeek, subBonusDays: bonusDays, subTotalDays: totalDays,
      subDates, subValidUntil: subDates[subDates.length - 1],
      subRedeemedDates: [],
      status: 'pending', confirmedByName: null,
    });
  } else {
    // ---- 1. Persist loyalty stamps + resolve the redeemed reward
    //         (best-effort; order still succeeds if Redis is unavailable) ----
    let redeemApplied = false;
    const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;

    if (userId) {
      try {
        const client = redisClient || (await getClient());
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

    resolvedOrder = Object.assign({}, order, {
      orderCode,
      discount: appliedDiscount, total: appliedTotal, remark, redeemedFreeCup: redeemApplied,
      status: 'pending', confirmedByName: null,
    });
  }

  // ---- 2. Send receipt to the customer ----
  let customerNotified = false;
  let customerMessageId = null;
  const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
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
      if (customerNotified) customerMessageId = tgData.result && tgData.result.message_id;
      if (!customerNotified) console.error('Customer receipt failed', tgData);
    } catch (err) {
      console.error('Customer receipt error', err);
    }
  }

  // ---- 3. Send report to the staff group, with Mark Paid / Not Received
  //         (+ Redeem Today for subscriptions) buttons, and remember it in
  //         Redis so the webhook can edit it. ----
  let groupNotified = false;
  try {
    const groupMessage = formatGroupMessage(resolvedOrder);
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: GROUP_CHAT_ID, text: groupMessage, parse_mode: 'HTML',
        reply_markup: groupKeyboard(resolvedOrder.orderCode, 'pending', resolvedOrder.orderType),
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
          // Kept so a later status change (webhook) can re-render and edit
          // the customer's own receipt message, not just the staff one.
          customerChatId: userId, customerMessageId,
          stamps, freeCups, stampsNeeded: STAMPS_NEEDED,
        });
        await client.set(`order:${resolvedOrder.orderCode}`, JSON.stringify(orderRecord), { EX: ORDER_TTL_SECONDS });
        // Index this order as "still awaiting payment" so the bank-notification
        // matcher (api/telegram-webhook.js) can scan only open orders instead
        // of every order ever placed. Entries are removed once resolved.
        await client.sAdd('pending_orders', resolvedOrder.orderCode);
        // Log the order to the Google Sheet order log (best-effort — never
        // blocks or fails the order itself).
        await pushOrderToSheet(orderRecord);
      } catch (err) {
        console.error('Order status persistence failed (buttons will not work for this order)', err);
      }
    }
  } catch (err) {
    console.error('Group notify error', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }

  return res.status(200).json({
    ok: true, orderCode, stamps, freeCups, customerNotified, groupNotified,
    discount: appliedDiscount, total: appliedTotal, lastCupPrice,
    subValidUntil: resolvedOrder.subValidUntil || null,
    subBonusDays: typeof resolvedOrder.subBonusDays === 'number' ? resolvedOrder.subBonusDays : null,
  });
}
