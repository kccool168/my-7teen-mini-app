// Vercel serverless function: POST /api/telegram-webhook
//
// Telegram calls this whenever an update happens on the bot — we only care
// about callback_query updates, which fire when staff tap the "Mark Paid"
// or "Not Received" inline button under an order report in the group chat.
//
// Flow: look up the order in Redis by its order code -> update its status
// -> edit the original group message in place to show the new status (and
// who confirmed it) -> acknowledge the tap so Telegram clears the button's
// loading spinner.
import getClient from './_redis.js';
import { formatGroupMessage, groupKeyboard } from './_format.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

  // Reject anything that doesn't present the secret Telegram was configured
  // to send, so random requests to this URL can't forge button presses.
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

  const cq = update && update.callback_query;
  if (!cq) {
    // Some other update type we don't act on — acknowledge so Telegram
    // doesn't keep retrying delivery.
    return res.status(200).end();
  }

  if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN environment variable');
    return res.status(200).end();
  }

  try {
    await handleCallback(cq, BOT_TOKEN);
  } catch (err) {
    console.error('Callback handling failed', err);
  }
  return res.status(200).end();
}

async function handleCallback(cq, BOT_TOKEN) {
  const data = String(cq.data || '');
  const sep = data.indexOf(':');
  const action = sep === -1 ? data : data.slice(0, sep);
  const orderCode = sep === -1 ? '' : data.slice(sep + 1);

  if (!orderCode || (action !== 'paid' && action !== 'unpaid')) {
    return answerCallback(BOT_TOKEN, cq.id, 'Unrecognized action');
  }

  let client;
  try {
    client = await getClient();
  } catch (err) {
    console.error('Redis unavailable for callback', err);
    return answerCallback(BOT_TOKEN, cq.id, 'Could not reach the database — try again shortly.');
  }

  const key = `order:${orderCode}`;
  const raw = await client.get(key);
  if (!raw) {
    return answerCallback(BOT_TOKEN, cq.id, 'Order not found (it may have expired after 14 days).');
  }

  let order;
  try {
    order = JSON.parse(raw);
  } catch (err) {
    console.error('Corrupt order record', err);
    return answerCallback(BOT_TOKEN, cq.id, 'Order record unreadable.');
  }

  const newStatus = action === 'paid' ? 'paid' : 'unpaid';
  const confirmedByName = [cq.from && cq.from.first_name, cq.from && cq.from.last_name]
    .filter(Boolean).join(' ') || (cq.from && cq.from.username) || 'Staff';

  order.status = newStatus;
  order.confirmedByName = confirmedByName;
  order.confirmedAt = new Date().toISOString();

  // Preserve the remaining TTL rather than resetting it, so a status flip
  // doesn't keep old orders alive indefinitely.
  const ttl = await client.ttl(key);
  const setOpts = ttl && ttl > 0 ? { EX: ttl } : {};
  await client.set(key, JSON.stringify(order), setOpts);

  const newText = formatGroupMessage(order);
  const chatId = (cq.message && cq.message.chat && cq.message.chat.id) || order.chatId;
  const messageId = (cq.message && cq.message.message_id) || order.messageId;

  if (chatId != null && messageId != null) {
    try {
      const editRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, message_id: messageId, text: newText, parse_mode: 'HTML',
          reply_markup: groupKeyboard(orderCode, newStatus),
        }),
      });
      const editData = await editRes.json();
      if (!editRes.ok || !editData.ok) console.error('editMessageText failed', editData);
    } catch (err) {
      console.error('editMessageText error', err);
    }
  }

  return answerCallback(
    BOT_TOKEN, cq.id,
    newStatus === 'paid' ? 'Marked as paid ✅' : 'Marked as not received ❌',
  );
}

async function answerCallback(BOT_TOKEN, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (err) {
    console.error('answerCallbackQuery failed', err);
  }
}
