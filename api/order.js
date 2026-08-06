// Vercel serverless function: /api/order
// Receives an order from the 7Teen Café Mini App and forwards a formatted
// report to the shop owner via the Telegram Bot API. No database required —
// the order lives only in the customer's session and this one message.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!BOT_TOKEN || !OWNER_CHAT_ID) {
    console.error('Missing BOT_TOKEN or OWNER_CHAT_ID environment variable');
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

  const message = formatOrderMessage(order);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    const tgData = await tgRes.json();
    if (!tgRes.ok || !tgData.ok) {
      console.error('Telegram API error', tgData);
      return res.status(502).json({ ok: false, error: 'Failed to notify owner' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Order notify failed', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
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

function formatOrderMessage(order) {
  const lines = [];
  lines.push(`🧾 <b>New order — ${esc(order.orderCode || '')}</b>`);
  lines.push('');

  order.items.forEach((item) => {
    const details = [];
    if (item.sugar) details.push(`${esc(item.sugar)} sugar`);
    if (item.addons && item.addons.length) details.push(item.addons.map(esc).join(', '));
    const detailStr = details.length ? ` (${details.join(', ')})` : '';
    lines.push(`• ${item.qty}× ${esc(item.name)}${detailStr} — $${money(item.unitPrice * item.qty)}`);
  });

  lines.push('');
  lines.push(`Subtotal: $${money(order.subtotal)}`);
  if (order.redeemedFreeCup && order.discount) {
    lines.push(`Free cup reward: −$${money(order.discount)}`);
  }
  lines.push(`<b>Total: $${money(order.total)}</b>`);
  lines.push('');

  if (order.customer) {
    const name = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(' ');
    const handle = order.customer.username ? ` (@${esc(order.customer.username)})` : '';
    lines.push(`👤 ${esc(name) || 'Customer'}${handle}`);
  }

  if (order.timestamp) {
    lines.push(`🕐 ${esc(order.timestamp)}`);
  }

  return lines.join('\n');
}
