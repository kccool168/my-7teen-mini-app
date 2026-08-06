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
//     staff Telegram group.
import getClient from './_redis.js';

const STAMPS_NEEDED = 6;

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
  const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;

  if (userId) {
    try {
      const client = await getClient();
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
  });

  // ---- 2. Send receipt to the customer ----
  let customerNotified = false;
  if (userId) {
    try {
      const receiptMessage = formatReceiptMessage(resolvedOrder, stamps, freeCups);
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

  // ---- 3. Send report to the staff group ----
  let groupNotified = false;
  try {
    const groupMessage = formatGroupMessage(resolvedOrder);
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: GROUP_CHAT_ID, text: groupMessage, parse_mode: 'HTML' }),
    });
    const tgData = await tgRes.json();
    groupNotified = !!(tgRes.ok && tgData.ok);
    if (!groupNotified) {
      console.error('Group notify failed', tgData);
      return res.status(502).json({ ok: false, error: 'Failed to notify group' });
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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(n) {
  return Number(n || 0).toFixed(2);
}

// Formats a timestamp as "DD/MM/YYYY - HH:MM" in Cambodia local time (ICT,
// UTC+7), regardless of what timezone the server itself runs in.
function formatTimestamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('day')}/${get('month')}/${get('year')} - ${get('hour')}:${get('minute')}`;
}

function itemLines(order) {
  return order.items.map((item) => {
    const details = [];
    if (item.sugar) details.push(`${esc(item.sugar)} sugar`);
    if (item.addons && item.addons.length) details.push(item.addons.map(esc).join(', '));
    const detailStr = details.length ? ` (${details.join(', ')})` : '';
    return `• ${item.qty}× ${esc(item.name)}${detailStr} — $${money(item.unitPrice * item.qty)}`;
  });
}

function formatGroupMessage(order) {
  const lines = [];
  lines.push(`🧾 <b>New order — ${esc(order.orderCode || '')}</b>`);
  lines.push('');
  lines.push(...itemLines(order));
  lines.push('');
  lines.push(`Subtotal: $${money(order.subtotal)}`);
  if (order.redeemedFreeCup && order.discount) lines.push(`Free cup reward: −$${money(order.discount)}`);
  lines.push(`<b>Total: $${money(order.total)}</b>`);
  lines.push('');

  if (order.customer) {
    const name = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ');
    const handle = order.customer.username ? ` (@${esc(order.customer.username)})` : '';
    lines.push(`👤 ${esc(name) || 'Customer'}${handle}`);
  }
  if (order.remark) lines.push(`📝 Remark: ${esc(order.remark)}`);
  lines.push(`🕐 ${esc(formatTimestamp(order.timestamp))}`);

  return lines.join('\n');
}

function formatReceiptMessage(order, stamps, freeCups) {
  const lines = [];
  lines.push(`✅ <b>Order confirmed!</b>`);
  lines.push(`Pickup code: <b>${esc(order.orderCode || '')}</b>`);
  lines.push(`🕐 ${esc(formatTimestamp(order.timestamp))}`);
  lines.push('');
  lines.push(...itemLines(order));
  lines.push('');
  lines.push(`Subtotal: $${money(order.subtotal)}`);
  if (order.redeemedFreeCup && order.discount) lines.push(`Free cup reward: −$${money(order.discount)}`);
  lines.push(`<b>Total: $${money(order.total)}</b>`);
  lines.push('');

  if (freeCups > 0) {
    lines.push(`☕ Loyalty: ${stamps}/${STAMPS_NEEDED} stamps — ${freeCups} free cup${freeCups === 1 ? '' : 's'} ready to redeem!`);
  } else {
    lines.push(`☕ Loyalty: ${stamps}/${STAMPS_NEEDED} stamps`);
  }
  lines.push('');
  lines.push('Thank you for ordering from 7Teen Café! 💙');

  return lines.join('\n');
}
