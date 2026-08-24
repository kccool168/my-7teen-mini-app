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
import { formatGroupMessage, formatReceiptMessage, groupKeyboard, todayInPhnomPenh, nowTimePhnomPenh, computeSubDates, formatCalendarDate, formatCalendarDateShort } from './_format.js';
import { pushStatusToSheet } from './_sheets.js';

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

// Owner-only commands (/subscription_report, /notify_reminder) only work
// when sent from this Telegram user id -- Ratana's personal account -- so a
// customer can never trigger a mass notification or see the full
// subscription list just by DMing the bot.
const OWNER_ID = '403684063';

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

  // orderCode currently holds "orderCode:date" for these two actions since
  // the generic split above only cuts at the first colon.
  if (action === 'cancelskip') {
        await editSkipMessage(BOT_TOKEN, cq.message, 'Okay, no changes made.');
        return answerCallback(BOT_TOKEN, cq.id, 'Cancelled');
  }

  if (action === 'doskip') {
        const parts = orderCode.split(':');
        const realOrderCode = parts[0];
        const dateToSkip = parts[1];
        if (!realOrderCode || !dateToSkip) {
                return answerCallback(BOT_TOKEN, cq.id, 'Unrecognized action');
        }

      const raw = await client.get(`order:${realOrderCode}`);
        if (!raw) {
                await editSkipMessage(BOT_TOKEN, cq.message, 'This subscription could not be found (it may have expired).');
                return answerCallback(BOT_TOKEN, cq.id, 'Not found', true);
        }
        let order;
        try {
                order = JSON.parse(raw);
        } catch (err) {
                return answerCallback(BOT_TOKEN, cq.id, 'Something went wrong.', true);
        }

      if (!order.customer || String(order.customer.id) !== String(cq.from.id)) {
              return answerCallback(BOT_TOKEN, cq.id, 'This is not your subscription.', true);
      }

      const today = todayInPhnomPenh();
        if (dateToSkip === today && nowTimePhnomPenh().hour >= 7) {
                await editSkipMessage(BOT_TOKEN, cq.message, "⏰ Sorry, it's now past 7:00 AM so today's cup is already being prepared and can't be skipped. Please message staff directly if you need a change.");
                return answerCallback(BOT_TOKEN, cq.id, 'Too late for today', true);
        }

      const result = await applySkip(BOT_TOKEN, realOrderCode, order, dateToSkip);
        await editSkipMessage(BOT_TOKEN, cq.message, result.message);
        return answerCallback(BOT_TOKEN, cq.id, result.ok ? 'Done ✅' : 'Could not skip', !result.ok);
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

async function sendPlainMessage(BOT_TOKEN, chatId, text, replyMarkup) {
    try {
          const body = { chat_id: chatId, text };
          if (replyMarkup) body.reply_markup = replyMarkup;
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
          });
    } catch (err) {
          console.error('sendPlainMessage failed', err);
    }
}

// ---- "/skip" — a subscriber types this in their DM with the bot. Rather
//      than always skipping "today", we look up their subscription and show
//      every remaining (not yet redeemed/skipped) date as a button so they
//      can pick exactly which day to skip. Tapping a date applies the same
//      skip-and-push-forward logic, parameterized by whichever date they
//      chose instead of always "today". ----
// Walks forward day-by-day from the last date already in `dates`, using
// the weekday pattern implied by `dates` itself, until it finds a
// qualifying date not already in the list.
function nextQualifyingDate(dates) {
    if (!dates.length) return null;
    const dow = new Set(dates.map(function (d) { return new Date(d + 'T00:00:00Z').getUTCDay(); }));
    const sorted = dates.slice().sort();
    const cur = new Date(sorted[sorted.length - 1] + 'T00:00:00Z');
    for (let i = 0; i < 30; i++) {
          cur.setUTCDate(cur.getUTCDate() + 1);
          const iso = cur.toISOString().slice(0, 10);
          if (dow.has(cur.getUTCDay()) && dates.indexOf(iso) === -1) return iso;
    }
    return null;
}

async function findActiveSubscriptionForUser(client, userId) {
    const orderCodes = await client.sMembers('active_subscriptions');
    for (const code of orderCodes) {
          const raw = await client.get(`order:${code}`);
          if (!raw) continue;
          let o;
          try { o = JSON.parse(raw); } catch (err) { continue; }
          if (o.customer && String(o.customer.id) === userId) {
                  return { order: o, orderCode: code };
          }
    }
    return null;
}

// Any date still in the schedule that hasn't already been redeemed or
// skipped, from today onward — these are the only days it makes sense to
// offer skipping.
function eligibleSkipDates(order) {
      const today = todayInPhnomPenh();
      // Today can only be skipped before 7:00 AM (prep starts after that) — once
      // that window has passed, don't offer it as an option at all, since tapping
      // it could only ever end in a rejection.
      const canSkipToday = nowTimePhnomPenh().hour < 7;
      const dates = Array.isArray(order.subDates) ? order.subDates : [];
      const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates : [];
      const skipped = Array.isArray(order.subSkippedDates) ? order.subSkippedDates : [];
      return dates
        .filter(function (d) {
                  if (d < today) return false;
                  if (d === today && !canSkipToday) return false;
                  return redeemed.indexOf(d) === -1 && skipped.indexOf(d) === -1;
        })
        .sort();
}

function skipDateKeyboard(orderCode, dates, today) {
    const rows = dates.map(function (d) {
          const label = (d === today ? 'Today, ' : '') + formatCalendarDate(d);
          return [{ text: label, callback_data: 'doskip:' + orderCode + ':' + d }];
    });
    rows.push([{ text: 'Cancel', callback_data: 'cancelskip:' + orderCode }]);
    return { inline_keyboard: rows };
}

async function editSkipMessage(BOT_TOKEN, cqMessage, text) {
    if (!cqMessage || !cqMessage.chat) return;
    try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                            chat_id: cqMessage.chat.id, message_id: cqMessage.message_id, text,
                            reply_markup: { inline_keyboard: [] },
                  }),
          });
    } catch (err) {
          console.error('editSkipMessage failed', err);
    }
}

// Applies the skip for one specific date: drops it from the schedule and
// appends one qualifying day at the end so the subscriber doesn't lose a
// day they already paid for, then keeps the staff group and Sheet in sync.
async function applySkip(BOT_TOKEN, orderCode, order, dateToSkip) {
    const dates = Array.isArray(order.subDates) ? order.subDates.slice() : [];
    const idx = dates.indexOf(dateToSkip);
    if (idx === -1) {
          return { ok: false, message: "That day isn't part of your subscription schedule anymore." };
    }
    const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates : [];
    if (redeemed.indexOf(dateToSkip) !== -1) {
          return { ok: false, message: "That day is already redeemed, so it can't be skipped." };
    }
    const skipped = Array.isArray(order.subSkippedDates) ? order.subSkippedDates.slice() : [];
    if (skipped.indexOf(dateToSkip) !== -1) {
          return { ok: false, message: 'That day is already marked as skipped.' };
    }

  const newDate = nextQualifyingDate(dates);
    if (!newDate) {
          return { ok: false, message: "Couldn't work out your next subscription day — please contact staff." };
    }
    dates.splice(idx, 1);
    dates.push(newDate);
    dates.sort();
    skipped.push(dateToSkip);

  order.subDates = dates;
    order.subSkippedDates = skipped;
    order.subValidUntil = dates[dates.length - 1];

  const client = await getClient();
    const key = `order:${orderCode}`;
    const ttl = await client.ttl(key);
    const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
    await client.set(key, JSON.stringify(order), setOpts);

  // Let staff know in the group so they're not left wondering where a
  // subscriber is, and refresh the existing report card with the new dates.
  await editGroupMessage(BOT_TOKEN, order, order.status);
    if (order.chatId) {
          const customerName = order.customer ? [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ') : '';
          const who = customerName || 'A customer';
          await sendPlainMessage(BOT_TOKEN, order.chatId, `⏭️ ${who} skipped ${formatCalendarDate(dateToSkip)} (order #${orderCode}). New valid until: ${formatCalendarDate(order.subValidUntil)}.`);
    }

  // Keep the Google Sheet order log's "Sub Valid Until" column current
  // too (best-effort — never blocks the reply if the sheet sync doesn't
  // pick up the extra field).
    await pushStatusToSheet(orderCode, order.status, order.confirmedByName, { subValidUntil: order.subValidUntil });

      // Only list days that are genuinely still ahead: drop anything already
      // redeemed, and drop today once the 7:00 AM prep cutoff has passed (it's
      // no longer something the customer is still waiting on).
      const today = todayInPhnomPenh();
      const todayIsDone = nowTimePhnomPenh().hour >= 7;
      const upcoming = dates.filter(function (d) {
              if (redeemed.indexOf(d) !== -1) return false;
              if (d === today && todayIsDone) return false;
              return true;
      });

      return { ok: true, message: `Skipped ${formatCalendarDate(dateToSkip)}. Your subscription now runs through ${formatCalendarDate(order.subValidUntil)}: ${upcoming.map(formatCalendarDateShort).join(', ')}.` };
}
// ---- "/subscription" -- quick status check showing a subscriber their
//      current schedule: valid-until date, upcoming days, and which ones
//      are already redeemed. ----
function buildSubscriptionStatusMessage(order) {
      const dates = Array.isArray(order.subDates) ? order.subDates.slice().sort() : [];
      const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates : [];
      const skipped = Array.isArray(order.subSkippedDates) ? order.subSkippedDates : [];

      const lines = dates.map(function (d) {
              const tag = redeemed.indexOf(d) !== -1 ? ' - redeemed' : '';
              return `- ${formatCalendarDateShort(d)}${tag}`;
      });

      const item = order.items && order.items[0];
        const drinkBits = item ? [item.sugar ? (item.sugar + ' sugar') : null, (item.addons && item.addons.length ? item.addons.join(', ') : null)].filter(Boolean) : [];
        const drinkLine = item ? `Drink: ${item.name}${drinkBits.length ? ' (' + drinkBits.join(', ') + ')' : ''} - $${Number(item.unitPrice || 0).toFixed(2)}/day\n` : '';
            let msg = `Your Subscription\n${drinkLine}Valid until: ${formatCalendarDate(order.subValidUntil)}\n\n${lines.join('\n')}`;
      if (skipped.length) {
              msg += `\n\nSkipped: ${skipped.map(formatCalendarDateShort).join(', ')}`;
      }
      return msg;
}


// ---- "/notify_reminder" (owner only) -- manually fires the same
//      reminder the paused daily cron would send, so the owner can nudge
//      everyone on demand even while the automatic run stays paused. ----
async function sendReminderToAllUsers(BOT_TOKEN) {
  const client = await getClient();
  const REMINDER_TEXT = "Hey MoyMoy! Just a friendly reminder from 7Teen Cafe -- looks like you haven't ordered yet for tmr. Don't miss out on your coffee. Order Now!";

  const activeSubUsers = new Set();
  try {
    const subCodes = await client.sMembers('active_subscriptions');
    for (const code of subCodes) {
      const raw = await client.get(`order:${code}`);
      if (!raw) continue;
      let order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
      if (userId) activeSubUsers.add(userId);
    }
  } catch (err) {
    console.error('Failed to resolve active subscribers for manual reminder', err);
  }

  const today = todayInPhnomPenh();
  const windowStart = new Date(`${today}T06:00:00.000Z`).getTime();
  const now = Date.now();

  const knownUsers = new Set();
  const orderedSince1pm = new Set();

  for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
    const raw = await client.get(key);
    if (!raw) continue;
    let order;
    try { order = JSON.parse(raw); } catch (e) { continue; }
    const userId = order.customer && order.customer.id != null ? String(order.customer.id) : null;
    if (!userId) continue;
    knownUsers.add(userId);
    if (order.orderType === 'subscription') continue;
    const ts = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
    if (!isNaN(ts) && ts >= windowStart && ts <= now) {
      orderedSince1pm.add(userId);
    }
  }

  let reminded = 0;
  let skipped = 0;
  for (const userId of knownUsers) {
    if (activeSubUsers.has(userId) || orderedSince1pm.has(userId)) { skipped++; continue; }
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text: REMINDER_TEXT }),
      });
      const tgData = await tgRes.json();
      if (tgRes.ok && tgData.ok) reminded++;
      else console.error(`Manual reminder failed for user ${userId}`, tgData);
    } catch (err) {
      console.error(`Manual reminder error for user ${userId}`, err);
    }
  }

  return { knownUsers: knownUsers.size, activeSubscribers: activeSubUsers.size, orderedSince1pm: orderedSince1pm.size, reminded, skipped };
}

// ---- "/subscription_report" (owner only) -- live snapshot of every
//      active subscription, so the owner doesn't have to open the sheet or
//      ask staff. ----
function buildSubscriptionReportMessage(subs) {
  if (!subs.length) return 'No active subscriptions right now.';
  const today = todayInPhnomPenh();
  const lines = [`Live Subscription Report (${subs.length} active)`, ''];
  subs.forEach((o, i) => {
    const c = o.customer || {};
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer';
    const handle = c.username ? ` (@${c.username})` : '';
    const item = o.items && o.items[0];
    const drink = item ? `${item.name}${item.sugar ? ' (' + item.sugar + ' sugar)' : ''}` : '';
    const dates = Array.isArray(o.subDates) ? o.subDates : [];
    const redeemed = Array.isArray(o.subRedeemedDates) ? o.subRedeemedDates : [];
    const dueToday = dates.indexOf(today) !== -1 && redeemed.indexOf(today) === -1;
    lines.push(`${i + 1}. ${name}${handle} -- ${drink}`);
    lines.push(`   Valid until: ${formatCalendarDate(o.subValidUntil)} | Redeemed: ${redeemed.length}/${dates.length}${dueToday ? ' | Due today' : ''}`);
  });
  return lines.join('\n');
}

// ---- "/loyalty_point" (owner only) -- live snapshot of every
//      customer's loyalty stamp progress, so the owner doesn't have to
//      open the sheet or ask staff. ----
function buildLoyaltyReportMessage(rows) {
  if (!rows.length) return 'No loyalty stamps recorded yet.';
  rows.sort((a, b) => b.total - a.total);
  const lines = [`Loyalty Stamps Report (${rows.length} customers)`, ''];
  rows.forEach((r, i) => {
    const handle = r.username ? ` (@${r.username})` : '';
    const freeCupTag = r.freeCups ? ` | ${r.freeCups} free cup${r.freeCups > 1 ? 's' : ''} available` : '';
    lines.push(`${i + 1}. ${r.name}${handle} -- ${r.stamps}/6 stamps${freeCupTag}`);
  });
  return lines.join('\n');
}

async function handleMessage(message, BOT_TOKEN) {
    const skipCommandText = message && typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/start\b/i.test(skipCommandText) && message.from && message.chat) {
            const welcomeText = "Welcome to 7Teen Cafe! ☕\n\nOrder your favorite coffee, tea, and more right from our Mini App, or subscribe for daily delivery and save.\n\nUseful commands:\n/subscription - check your subscription status\n/skip - skip a subscription day\n\nTap below to start ordering!";
            const startKeyboard = { inline_keyboard: [[{ text: 'Order Now', web_app: { url: 'https://my-7teen-mini-app.vercel.app' } }]] };
            await sendPlainMessage(BOT_TOKEN, message.chat.id, welcomeText, startKeyboard);
            return;
    }
    
    if (/^\/subscription\b/i.test(skipCommandText) && message.from && message.chat) {
            // Quick status check -- shows the subscriber their current schedule.
            let reply = null;
            try {
                      const client = await getClient();
                      const found = await findActiveSubscriptionForUser(client, String(message.from.id));
                      reply = found ? buildSubscriptionStatusMessage(found.order) : "You don't have an active subscription right now.";
            } catch (err) {
                      console.error('/subscription command failed', err);
                      reply = 'Something went wrong looking up your subscription -- please try again, or let staff know if it keeps happening.';
            }
            await sendPlainMessage(BOT_TOKEN, message.chat.id, reply);
            return;
    }
    
    if (/^\/skip\b/i.test(skipCommandText) && message.from && message.chat) {
          // Show the subscriber every upcoming day they can still skip, as
      // buttons, and let them pick one. Whether a given day can actually be
      // skipped (e.g. today after 7:00 AM) is checked when they tap it.
      let reply = null;
          let keyboard = null;
          try {
                  const client = await getClient();
                  const found = await findActiveSubscriptionForUser(client, String(message.from.id));
                  if (!found) {
                            reply = "You don't have an active subscription right now.";
                  } else {
                            const dates = eligibleSkipDates(found.order);
                            if (!dates.length) {
                                        reply = "You don't have any upcoming subscription days available to skip right now.";
                            } else {
                                        reply = 'Which day would you like to skip?';
                                        keyboard = skipDateKeyboard(found.orderCode, dates, todayInPhnomPenh());
                            }
                  }
          } catch (err) {
                  console.error('/skip command failed', err);
                  reply = 'Something went wrong processing /skip — please try again, or let staff know if it keeps happening.';
          }
          await sendPlainMessage(BOT_TOKEN, message.chat.id, reply, keyboard);
          return;
    }

      if (/^\/subscription_report\b/i.test(skipCommandText) && message.from && message.chat) {
      if (String(message.from.id) !== OWNER_ID) return; // silently ignore non-owner
      let reply = null;
      try {
        const client = await getClient();
        const subCodes = await client.sMembers('active_subscriptions');
        const subs = [];
        for (const code of subCodes) {
          const raw = await client.get(`order:${code}`);
          if (!raw) continue;
          let o;
          try { o = JSON.parse(raw); } catch (e) { continue; }
          subs.push(o);
        }
        // active_subscriptions is only pruned once/day by the expiry-check
        // cron, so a subscription that expired since the last run can still
        // be a member of the set -- filter it out here too so the report
        // never shows something already expired.
        const today = todayInPhnomPenh();
        const activeSubs = subs.filter((o) => !o.subValidUntil || o.subValidUntil >= today);
        reply = buildSubscriptionReportMessage(activeSubs);
      } catch (err) {
        console.error('/subscription_report command failed', err);
        reply = 'Something went wrong pulling the subscription report -- please try again.';
      }
      await sendPlainMessage(BOT_TOKEN, message.chat.id, reply);
      return;
    }

    if (/^\/notify_reminder\b/i.test(skipCommandText) && message.from && message.chat) {
      if (String(message.from.id) !== OWNER_ID) return; // silently ignore non-owner
      await sendPlainMessage(BOT_TOKEN, message.chat.id, 'Sending reminder to all eligible customers now...');
      let result;
      try {
        result = await sendReminderToAllUsers(BOT_TOKEN);
      } catch (err) {
        console.error('/notify_reminder command failed', err);
        await sendPlainMessage(BOT_TOKEN, message.chat.id, 'Something went wrong sending reminders -- check Vercel logs.');
        return;
      }
      const summary = `Reminder sent.\nKnown customers: ${result.knownUsers}\nActive subscribers (skipped): ${result.activeSubscribers}\nAlready ordered since 1PM (skipped): ${result.orderedSince1pm}\nReminded: ${result.reminded}`;
      await sendPlainMessage(BOT_TOKEN, message.chat.id, summary);
      return;
    }

    if (/^\/loyalty_point\b/i.test(skipCommandText) && message.from && message.chat) {
      if (String(message.from.id) !== OWNER_ID) return; // silently ignore non-owner
      let reply = null;
      try {
        const client = await getClient();
        const userMap = new Map();
        for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
          const raw = await client.get(key);
          if (!raw) continue;
          let order;
          try { order = JSON.parse(raw); } catch (e) { continue; }
          const c = order.customer || {};
          if (c.id == null) continue;
          const userId = String(c.id);
          const ts = order.timestamp ? new Date(order.timestamp).getTime() : 0;
          const existing = userMap.get(userId);
          if (!existing || ts > existing.ts) {
            userMap.set(userId, { ts, firstName: c.firstName, lastName: c.lastName, username: c.username });
          }
        }
        const STAMPS_NEEDED = 6;
        const rows = [];
        for (const [userId, info] of userMap) {
          const [totalStr, usedStr] = await Promise.all([
            client.get(`user:${userId}:total`),
            client.get(`user:${userId}:used`),
          ]);
          const total = parseInt(totalStr || '0', 10) || 0;
          if (total <= 0) continue;
          const used = parseInt(usedStr || '0', 10) || 0;
          const stamps = total % STAMPS_NEEDED;
          const freeCups = Math.max(0, Math.floor(total / STAMPS_NEEDED) - used);
          const name = [info.firstName, info.lastName].filter(Boolean).join(' ') || 'Customer';
          rows.push({ name, username: info.username, stamps, freeCups, total });
        }
        reply = buildLoyaltyReportMessage(rows);
      } catch (err) {
        console.error('/loyalty_point command failed', err);
        reply = 'Something went wrong pulling loyalty points -- please try again.';
      }
      await sendPlainMessage(BOT_TOKEN, message.chat.id, reply);
      return;
    }

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
    // Keep the Google Sheet order log's Status / Confirmed By columns current
  // too (best-effort — never blocks a status change).
  await pushStatusToSheet(orderCode, newStatus, confirmedByName);

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
