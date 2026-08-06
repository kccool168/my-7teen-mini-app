// Shared Telegram message formatting used by both api/order.js (creates the
// order report) and api/telegram-webhook.js (edits it when staff tap a
// "Mark Paid" / "Not Received" button). Keeping this in one place means the
// message staff see right after ordering and the message they see after
// confirming payment are always built the same way.

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function money(n) {
  return Number(n || 0).toFixed(2);
}

// Formats a timestamp as "DD/MM/YYYY - HH:MM" in Cambodia local time (ICT,
// UTC+7), regardless of what timezone the server itself runs in.
export function formatTimestamp(iso) {
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

export function itemLines(order) {
  return order.items.map((item) => {
    const details = [];
    if (item.sugar) details.push(`${esc(item.sugar)} sugar`);
    if (item.addons && item.addons.length) details.push(item.addons.map(esc).join(', '));
    const detailStr = details.length ? ` (${details.join(', ')})` : '';
    return `• ${item.qty}× ${esc(item.name)}${detailStr} — $${money(item.unitPrice * item.qty)}`;
  });
}

function statusLine(order) {
  if (order.status === 'paid') {
    return `💰 Status: ✅ Paid${order.confirmedByName ? ' — confirmed by ' + esc(order.confirmedByName) : ''}`;
  }
  if (order.status === 'unpaid') {
    return `💰 Status: ❌ Not received${order.confirmedByName ? ' — marked by ' + esc(order.confirmedByName) : ''}`;
  }
  return '💰 Status: ⏳ Awaiting payment confirmation';
}

// The report sent to the staff group, plus its inline-button footer.
export function formatGroupMessage(order) {
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
  lines.push('');
  lines.push(statusLine(order));

  return lines.join('\n');
}

// Inline keyboard shown under the group report. Once a status is set, the
// remaining button lets staff flip it back (in case of a mis-tap).
export function groupKeyboard(orderCode, status) {
  if (status === 'paid') {
    return { inline_keyboard: [[{ text: '↩️ Undo (mark not received)', callback_data: 'unpaid:' + orderCode }]] };
  }
  if (status === 'unpaid') {
    return { inline_keyboard: [[{ text: '✅ Mark Paid', callback_data: 'paid:' + orderCode }]] };
  }
  return {
    inline_keyboard: [[
      { text: '✅ Mark Paid', callback_data: 'paid:' + orderCode },
      { text: '❌ Not Received', callback_data: 'unpaid:' + orderCode },
    ]],
  };
}

export function formatReceiptMessage(order, stamps, freeCups, stampsNeeded) {
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
    lines.push(`☕ Loyalty: ${stamps}/${stampsNeeded} stamps — ${freeCups} free cup${freeCups === 1 ? '' : 's'} ready to redeem!`);
  } else {
    lines.push(`☕ Loyalty: ${stamps}/${stampsNeeded} stamps`);
  }
  lines.push('');
  lines.push('Thank you for ordering from 7Teen Café! 💙');

  return lines.join('\n');
}
