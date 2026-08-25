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
//    loyalty free cup banked, it's redeemed as the LAST day of the
//    subscription itself (that day is $0) rather than tacked on as an
//    extra day — the subscription still runs exactly the length the
//    customer picked.
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
import { formatGroupMessage, formatReceiptMessage, groupKeyboard, computeSubDates, clampSubStartDate, todayInPhnomPenh, nowTimePhnomPenh } from './_format.js';
import { pushOrderToSheet, pushLoyaltyToSheet } from './_sheets.js';

const STAMPS_NEEDED = 6;
const MIN_STAMP_PRICE = 1.25; // cups priced below this don't earn a stamp
const MAX_REDEEM_PRICE = 1.75; // free-cup discount never exceeds this, regardless of earned cap
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

function addOneMonth(dateStr) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); }

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

  if (!isSubscription && order.pickupSlot !== 'morning' && order.pickupSlot !== 'afternoon') {
        return res.status(400).json({ ok: false, error: 'Order must include a valid pickup slot (morning or afternoon)' });
  }

  if (!isSubscription && nowTimePhnomPenh().hour === 7) {
        return res.status(423).json({ ok: false, error: 'Orders are paused 7:00-8:00 AM while delivery is on the way. Please try again after 8:00 AM.' });
  }

  const remark = typeof order.remark === 'string' ? order.remark.trim().slice(0, 50) : '';

  let resolvedOrder;
    let stamps = 0;
    let freeCups = 0;
    let appliedDiscount = 0;
    let appliedTotal = Number(order.subtotal) || 0;
    let lastCupPrice = null;
    let redisClient = null;

  let orderCode;
    try {
          redisClient = await getClient();
          orderCode = await generateOrderCode(redisClient);
    } catch (err) {
          console.error('Order code generation failed, using timestamp fallback', err);
          orderCode = `7T-${Date.now().toString().slice(-6)}`;
    }

  if (isSubscription) { const item = order.items[0]; const unitPrice = Number(item && item.unitPrice) || 0; const today = todayInPhnomPenh(); const maxSubDate = addOneMonth(today); const rawSubDates = Array.isArray(order.subDates) ? order.subDates : []; const subDates = Array.from(new Set(rawSubDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))).filter((d) => { if (d < today || d > maxSubDate) return false; const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); return dow !== 0; }).sort().slice(0, MAX_SUB_DAYS); if (subDates.length < 1) { return res.status(400).json({ ok: false, error: 'Subscription must include at least one valid day (Mon-Sat, within the next month)' }); } const subDays = subDates.length; const subStartDate = subDates[0];

      let freeCupApplied = false;
        let priorLastCupPrice = null;
        const subUserId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
        if (subUserId) {
                try {
                          const client = redisClient || (await getClient());
                          redisClient = client;
                          const totalKey = `user:${subUserId}:total`;
                          const usedKey = `user:${subUserId}:used`;
                          const lastPriceKey = `user:${subUserId}:lastPrice`;
                          const [totalStr, usedStr, lastPriceStr] = await Promise.all([
                                      client.get(totalKey), client.get(usedKey), client.get(lastPriceKey),
                                    ]);
                          const priorTotal = parseInt(totalStr || '0', 10) || 0;
                          const priorUsed = parseInt(usedStr || '0', 10) || 0;
                          const priorAvailable = Math.max(0, Math.floor(priorTotal / STAMPS_NEEDED) - priorUsed);
                          priorLastCupPrice = lastPriceStr != null ? parseFloat(lastPriceStr) : null;
                          stamps = priorTotal % STAMPS_NEEDED;
                          if (priorAvailable > 0) {
                                      freeCupApplied = true;
                                      await client.incr(usedKey);
                                      freeCups = Math.max(0, priorAvailable - 1);
                          } else {
                                      freeCups = 0;
                          }
                } catch (err) {
                          console.error('Free-cup redemption lookup failed for subscription', err);
                }
        }

      const subFreeDate = freeCupApplied ? subDates[subDates.length - 1] : null;
        const paidDays = subDays - (freeCupApplied ? 1 : 0);

      appliedDiscount = freeCupApplied
          ? Math.min(unitPrice, (priorLastCupPrice != null && !isNaN(priorLastCupPrice)) ? priorLastCupPrice : unitPrice, MAX_REDEEM_PRICE)
              : 0;
        const subSubtotal = Math.round(unitPrice * subDays * 100) / 100;
        appliedTotal = Math.max(0, Math.round((subSubtotal - appliedDiscount) * 100) / 100);

      if (subUserId && paidDays > 0) {
              try {
                        const client = redisClient || (await getClient());
                        redisClient = client;
                        const totalKey = `user:${subUserId}:total`;
                        const usedKey = `user:${subUserId}:used`;
                        const lastPriceKey = `user:${subUserId}:lastPrice`;
                        const subStampEarningDays = unitPrice >= MIN_STAMP_PRICE ? paidDays : 0;
                        const newTotal = await client.incrBy(totalKey, subStampEarningDays);
                        const usedStr = await client.get(usedKey);
                        const used = parseInt(usedStr || '0', 10) || 0;
                        stamps = newTotal % STAMPS_NEEDED;
                        freeCups = Math.max(0, Math.floor(newTotal / STAMPS_NEEDED) - used);
                        const priorMax = freeCupApplied ? 0 : (priorLastCupPrice || 0);
                        const newMaxPrice = Math.max(priorMax, unitPrice);
                        await client.set(lastPriceKey, newMaxPrice.toFixed(2));
                        lastCupPrice = Math.round(newMaxPrice * 100) / 100;
              } catch (err) {
                        console.error('Stamp persistence failed for subscription', err);
              }
      }

      resolvedOrder = Object.assign({}, order, {
              orderCode,
              orderType: 'subscription',
              items: [item],
              subtotal: subSubtotal, discount: appliedDiscount, total: appliedTotal,
              redeemedFreeCup: freeCupApplied, remark,
              subStartDate, subDays, subFreeDate,
              subDates, subValidUntil: subDates[subDates.length - 1],
              subRedeemedDates: [],
              status: 'pending', confirmedByName: null,
      });
  } else {
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

                if (order.redeemedFreeCup && priorAvailable > 0) {
                            redeemApplied = true;
                            await client.incr(usedKey);
                }

                if (redeemApplied) {
                            const maxUnitPrice = order.items.reduce((max, item) => Math.max(max, Number(item.unitPrice) || 0), 0);
                            appliedDiscount = (priorLastCupPrice != null && !isNaN(priorLastCupPrice))
                              ? Math.min(maxUnitPrice, priorLastCupPrice, MAX_REDEEM_PRICE)
                                          : Math.min(maxUnitPrice, MAX_REDEEM_PRICE);
                }
                        appliedTotal = Math.max(0, subtotal - appliedDiscount);

                const eligibleCups = order.items.reduce((sum, item) => {
                            const price = Number(item.unitPrice) || 0;
                            return sum + (price >= MIN_STAMP_PRICE ? (Number(item.qty) || 0) : 0);
                }, 0);
                        const stampEarningCups = Math.max(0, eligibleCups - (redeemApplied ? 1 : 0));
                        const newTotal = await client.incrBy(totalKey, stampEarningCups);
                        const usedStr2 = await client.get(usedKey);
                        const used2 = parseInt(usedStr2 || '0', 10) || 0;
                        stamps = newTotal % STAMPS_NEEDED;
                        freeCups = Math.max(0, Math.floor(newTotal / STAMPS_NEEDED) - used2);

                if (stampEarningCups > 0) {
                            const pricePerCup = appliedTotal / stampEarningCups;
                            const priorMax = redeemApplied ? 0 : (priorLastCupPrice || 0);
                            const newMaxPrice = Math.max(priorMax, pricePerCup);
                            await client.set(lastPriceKey, newMaxPrice.toFixed(2));
                            lastCupPrice = Math.round(newMaxPrice * 100) / 100;
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

  let customerNotified = false;
    let customerMessageId = null;
    const userId2 = order.customer && order.customer.id != null ? String(order.customer.id) : null;
    if (userId2) {
          try {
                  const receiptMessage = formatReceiptMessage(resolvedOrder, stamps, freeCups, STAMPS_NEEDED);
                  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: userId2, text: receiptMessage, parse_mode: 'HTML' }),
                  });
                  const tgData = await tgRes.json();
                  customerNotified = !!(tgRes.ok && tgData.ok);
                  if (customerNotified) customerMessageId = tgData.result && tgData.result.message_id;
                  if (!customerNotified) console.error('Customer receipt failed', tgData);
          } catch (err) {
                  console.error('Customer receipt error', err);
          }
    }

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
                                        customerChatId: userId2, customerMessageId,
                                        stamps, freeCups, stampsNeeded: STAMPS_NEEDED,
                            });
                            await client.set(`order:${resolvedOrder.orderCode}`, JSON.stringify(orderRecord), { EX: ORDER_TTL_SECONDS });
                            await client.sAdd('pending_orders', resolvedOrder.orderCode);
                            await pushOrderToSheet(orderRecord);
                            await pushLoyaltyToSheet(order.customer, stamps, freeCups, lastCupPrice);
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
        subFreeDate: typeof resolvedOrder.subFreeDate !== 'undefined' ? resolvedOrder.subFreeDate : null,
  });
}
