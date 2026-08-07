// Vercel serverless function: POST /api/telegram-webhook
//
// Telegram calls this for every update the bot is subscribed to. We handle
// two kinds:
//
//  1. callback_query — staff tapped a button under an order/subscription
//     report in the staff group: "Mark Paid" / "Not Received", or (for paid
//     subscriptions) "Redeem Today".
//  2. message — a plain message arrived in some group the bot belongs to.
//     We only act on it if it's from the designated bank-notification group
//     (BANK_NOTIFY_CHAT_ID) and looks like a Canadia Bank payment alert; if
//     it matches exactly one still-open order by amount and time, that
//     order is auto-confirmed the same way a manual tap would.
//
// Payment-status changes funnel through resolveOrderStatus(), which updates
// Redis and edits both the staff group message and the customer's own
// receipt message in place, so both stay in sync with the real status.
import getClient from './_redis.js';
import { formatGroupMessage, formatReceiptMessage, groupKeyboard, todayInPhnomPenh } from './_format.js';

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

// How far apart an order's creation time and a bank alert's timestamp can
// be and still be considered the same payment.
const MATCH_WINDOW_MS = 20 * 60 * 1000;
// How much the converted amount is allowed to drift from the order total
// (covers small exchange-rate movement day to day).
const MATCH_TOLERANCE_RATIO = 0.03;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

  // Reject anything that doesn't present the secret Telegram was configured
  // to send, so random requests to this URL can't forge button presses or
  // fake bank alerts.
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== WEBHOOK_SECRET) {
      return res.status(401).end();
    }
  }

  let update;
  try {
    update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).end();
  }

  if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    return res.status(200).end();
  }

  try {
    if (update && update.callback_query) {
      await handleCallback(update.callback_query, BOT_TOKEN);
    } else if (update && update.message) {
      await handleMessage(update.message, BOT_TOKEN);
    }
    // Any other update type: nothing to do, just acknowledge.
  } catch (err) {
    console.error('Webhook handling failed', err);
  }
  return res.status(200).end();
}

// ---- Button taps: "Mark Paid" / "Not Received" / "Redeem Today" ----

async function handleCallback(cq, BOT_TOKEN) {
  const data = String(cq.data || '');
  const sep = data.indexOf(':');
  const action = sep === -1 ? data : data.slice(0, sep);
  const orderCode = sep === -1 ? '' : data.slice(sep + 1);

  if (!orderCode) {
    return answerCallback(BOT_TOKEN, cq.id, 'Unrecognized action');
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for callback', err);
    return answerCallback(BOT_TOKEN, cq.id, 'Could not reach the database — try again shortly.');
  }

  const staffName = [cq.from && cq.from.first_name, cq.from && cq.from.last_name]
    .filter(Boolean).join(' ') || (cq.from && cq.from.username) || 'Staff';

  if (action === 'subredeem') {
    const result = await redeemSubscriptionDay(client, BOT_TOKEN, orderCode, staffName);
    return answerCallback(BOT_TOKEN, cq.id, result.message, result.alert);
  }

  if (action !== 'paid' && action !== 'unpaid') {
    return answerCallback(BOT_TOKEN, cq.id, 'Unrecognized action');
  }

  const newStatus = action === 'paid' ? 'paid' : 'unpaid';
  // A manual tap always overrides any prior auto-confirmation.
  const order = await resolveOrderStatus(client, BOT_TOKEN, orderCode, newStatus, staffName, { bankRef: null });
  if (!order) {
    return answerCallback(BOT_TOKEN, cq.id, 'Order not found (it may have expired after 14 days).');
  }

  return answerCallback(
    BOT_TOKEN, cq.id,
    newStatus === 'paid' ? 'Marked as paid ✅' : 'Marked as not received ❌',
  );
}

async function answerCallback(BOT_TOKEN, callbackQueryId, text, showAlert) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: !!showAlert }),
    });
  } catch (err) {
    console.error('answerCallbackQuery failed', err);
  }
}

// ---- Bank notification group messages ----

async function handleMessage(message, BOT_TOKEN) {
  const BANK_CHAT_ID = process.env.BANK_NOTIFY_CHAT_ID;
  const chatId = message.chat && message.chat.id;

  if (!BANK_CHAT_ID) {
    // Setup phase: BANK_NOTIFY_CHAT_ID hasn't been configured yet. Log just
    // enough to identify the right group (chat id + title), and nothing
    // else, so it can be found in Vercel's function logs and set as the
    // env var. Once BANK_NOTIFY_CHAT_ID is set this branch never runs.
    console.log('telegram-webhook: message seen before BANK_NOTIFY_CHAT_ID is configured — chat.id=' + chatId + ' chat.title=' + JSON.stringify(message.chat && message.chat.title));
    return;
  }

  if (String(chatId) !== String(BANK_CHAT_ID)) return; // Not the bank group — ignore silently.

  const text = message.text || message.caption || '';
  const parsed = parseBankNotification(text);
  if (!parsed) return; // Not a recognizable payment alert.

  const usdAmount = toUSD(parsed.amount, parsed.currency);

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for bank notification matching', err);
    return;
  }

  const pendingCodes = await client.sMembers('pending_orders');
  const candidates = [];
  for (const code of pendingCodes) {
    const raw = await client.get(`order:${code}`);
    if (!raw) { await client.sRem('pending_orders', code); continue; }
    let order;
    try { order = JSON.parse(raw); } catch (e) { continue; }
    if (order.status !== 'pending') { await client.sRem('pending_orders', code); continue; }

    const orderTime = new Date(order.timestamp).getTime();
    const withinTime = Math.abs(parsed.dateUTC.getTime() - orderTime) <= MATCH_WINDOW_MS;
    if (withinTime && amountsMatch(usdAmount, Number(order.total))) {
      candidates.push(order);
    }
  }

  if (candidates.length === 1) {
    await resolveOrderStatus(
      client, BOT_TOKEN, candidates[0].orderCode, 'paid', 'Bank notification (auto)',
      { bankRef: parsed.ref, bankPayer: parsed.payer },
    );
    console.log(`Auto-confirmed order ${candidates[0].orderCode} from bank ref ${parsed.ref}`);
  } else if (candidates.length > 1) {
    console.log(`Bank alert (Ref ${parsed.ref}, $${usdAmount.toFixed(2)}) matched ${candidates.length} pending orders — ambiguous, left for manual confirmation.`);
  }
  // Zero matches: likely already confirmed manually, or an unrelated
  // payment (e.g. supplier transfer) — nothing to do.
}

// Parses Canadia Bank's merchant payment notification text, e.g.:
// "6,000.00 KHR was paid to your account : 7TEEN CAFE 1673611000 on 06 AUG
//  2026 at 08:29:50 from Canadia Bank Acc : TANG SEAKMENG 001XXXXXXXX4868
//  with Ref: FT262180117X."
function parseBankNotification(text) {
  const re = /([\d,]+\.\d{2})\s*(KHR|USD)\s+was paid to your account\s*:\s*(.+?)\s+on\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})\s+from\s+.+?Acc\s*:\s*(.+?)\s+with\s+Ref\s*:\s*([A-Za-z0-9]+)\.?/i;
  const m = text.match(re);
  if (!m) return null;

  const [, amountStr, currency, account, day, monStr, year, hh, mm, ss, payer, ref] = m;
  const monthIdx = MONTHS[monStr.toUpperCase()];
  if (monthIdx == null) return null;

  // The bank's timestamp is Cambodia local time (ICT, UTC+7).
  const dateUTC = new Date(Date.UTC(
    parseInt(year, 10), monthIdx, parseInt(day, 10),
    parseInt(hh, 10) - 7, parseInt(mm, 10), parseInt(ss, 10),
  ));
  if (isNaN(dateUTC.getTime())) return null;

  return {
    amount: parseFloat(amountStr.replace(/,/g, '')),
    currency: currency.toUpperCase(),
    account: account.trim(),
    payer: payer.trim(),
    ref: ref.trim(),
    dateUTC,
  };
}

function toUSD(amount, currency) {
  if (currency === 'USD') return amount;
  const rate = parseFloat(process.env.KHR_USD_RATE || '4000') || 4000;
  return amount / rate;
}

function amountsMatch(a, b) {
  const diff = Math.abs(a - b);
  const tolerance = Math.max(0.02, b * MATCH_TOLERANCE_RATIO);
  return diff <= tolerance;
}

// ---- Shared: apply a status change, edit the group message, and edit the
//      customer's own receipt message so both stay in sync. ----

async function resolveOrderStatus(client, BOT_TOKEN, orderCode, newStatus, confirmedByName, extra) {
  const key = `order:${orderCode}`;
  const raw = await client.get(key);
  if (!raw) return null;

  let order;
  try {
    order = JSON.parse(raw);
  } catch (err) {
    console.error('Corrupt order record', orderCode, err);
    return null;
  }

  order.status = newStatus;
  order.confirmedByName = confirmedByName;
  order.confirmedAt = new Date().toISOString();
  if (extra) Object.assign(order, extra);

  // Preserve the remaining TTL rather than resetting it.
  const ttl = await client.ttl(key);
  const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
  await client.set(key, JSON.stringify(order), setOpts);
  await client.sRem('pending_orders', orderCode);

  // Paid subscriptions get tracked separately so the daily expiry check
  // only has to scan active subscriptions, not every order ever placed.
  if (order.orderType === 'subscription') {
    if (newStatus === 'paid') await client.sAdd('active_subscriptions', orderCode);
    else await client.sRem('active_subscriptions', orderCode);
  }

  await editGroupMessage(BOT_TOKEN, order, newStatus);
  await editCustomerReceipt(BOT_TOKEN, order);

  return order;
}

async function editGroupMessage(BOT_TOKEN, order, status) {
  const chatId = order.chatId;
  const messageId = order.messageId;
  if (chatId == null || messageId == null) return;
  try {
    const editRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId, text: formatGroupMessage(order), parse_mode: 'HTML',
        reply_markup: groupKeyboard(order.orderCode, status, order.orderType),
      }),
    });
    const editData = await editRes.json();
    if (!editRes.ok || !editData.ok) console.error('editMessageText (group) failed', editData);
  } catch (err) {
    console.error('editMessageText (group) error', err);
  }
}

// Keeps the customer's own receipt message current too, so "Payment
// Pending" flips to "Payment Done" (or "Payment Not Received") right in
// their chat, not just on the staff side.
async function editCustomerReceipt(BOT_TOKEN, order) {
  const chatId = order.customerChatId;
  const messageId = order.customerMessageId;
  if (chatId == null || messageId == null) return;
  try {
    const text = formatReceiptMessage(order, order.stamps || 0, order.freeCups || 0, order.stampsNeeded || 6);
    const editRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
    });
    const editData = await editRes.json();
    if (!editRes.ok || !editData.ok) console.error('editMessageText (receipt) failed', editData);
  } catch (err) {
    console.error('editMessageText (receipt) error', err);
  }
}

// ---- "Redeem Today" — marks today's pickup for a paid subscription ----

async function redeemSubscriptionDay(client, BOT_TOKEN, orderCode) {
  const key = `order:${orderCode}`;
  const raw = await client.get(key);
  if (!raw) return { message: 'Order not found (it may have expired after 14 days).', alert: true };

  let order;
  try {
    order = JSON.parse(raw);
  } catch (err) {
    console.error('Corrupt order record', orderCode, err);
    return { message: 'Something went wrong reading this subscription.', alert: true };
  }

  if (order.orderType !== 'subscription') {
    return { message: 'This is not a subscription order.', alert: true };
  }
  if (order.status !== 'paid') {
    return { message: 'Payment must be confirmed before redeeming.', alert: true };
  }

  const today = todayInPhnomPenh();
  const dates = Array.isArray(order.subDates) ? order.subDates : [];
  if (dates.indexOf(today) === -1) {
    return { message: 'Today is outside this subscription\'s date range.', alert: true };
  }

  const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates.slice() : [];
  if (redeemed.indexOf(today) !== -1) {
    return { message: 'Already redeemed for today ✅', alert: false };
  }

  redeemed.push(today);
  order.subRedeemedDates = redeemed;

  const ttl = await client.ttl(key);
  const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
  await client.set(key, JSON.stringify(order), setOpts);

  await editGroupMessage(BOT_TOKEN, order, order.status);

  return { message: 'Redeemed for today! ☕', alert: false };
}
