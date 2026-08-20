// Shared Telegram message formatting used by both api/order.js (creates the
// order report) and api/telegram-webhook.js (edits it when staff tap a
// "Mark Paid" / "Not Received" / "Redeem Today" button). Keeping this in one
// place means the message staff see right after ordering and the message
// they see after confirming payment/redeeming are always built the same way.
// Also shared with api/subscription-expiry-check.js for date math.

export function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

export function money(n) {
    return Number(n || 0).toFixed(2);
}

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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCalendarDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const y = parts[0];
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    const mn = MONTH_NAMES[m - 1] || '';
    return `${d} ${mn} ${y}`;
}

export function formatCalendarDateShort(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    const mn = MONTH_NAMES[m - 1] || '';
    return `${d} ${mn}`;
}

export function addDaysToDateStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

export function addMonthToDateStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCMonth(dt.getUTCMonth() + 1);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

export function dayOfWeekUTC(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isSelectedDateStr(dateStr, days) {
    return days.indexOf(dayOfWeekUTC(dateStr)) !== -1;
}

export function clampSubStartDate(dateStr, todayStr, days) {
    const min = todayStr;
    const max = addMonthToDateStr(min);
    let out = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) ? dateStr : min;
    if (out < min) out = min;
    if (out > max) out = max;
    if (!Array.isArray(days) || !days.length) return out;

  let cur = out;
    for (let i = 0; i < 40; i++) {
          if (isSelectedDateStr(cur, days)) return cur;
          const next = addDaysToDateStr(cur, 1);
          if (next > max) break;
          cur = next;
    }
    cur = out;
    for (let i = 0; i < 40; i++) {
          if (isSelectedDateStr(cur, days)) return cur;
          const prev = addDaysToDateStr(cur, -1);
          if (prev < min) break;
          cur = prev;
    }
    return out;
}

export function computeSubDates(startDateStr, totalDays, days) {
    const out = [];
    const n = Math.max(1, parseInt(totalDays, 10) || 0);
    let cur = startDateStr;
    let guard = 0;
    while (out.length < n && guard < 400) {
          guard++;
          if (isSelectedDateStr(cur, days)) out.push(cur);
          if (out.length < n) cur = addDaysToDateStr(cur, 1);
    }
    return out;
}

export function todayInPhnomPenh() {
    const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nowTimePhnomPenh() {
    const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '0';
    return { hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}

function pickupSlotLabel(order) {
    return order.pickupSlot === 'morning' ? 'Morning' : order.pickupSlot === 'afternoon' ? 'Afternoon' : '';
}

function summarizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const details = [];
    if (item.sugar) details.push(`${esc(item.sugar)} sugar`);
    if (item.addons && item.addons.length) details.push(item.addons.map(esc).join(', '));
    const detailStr = details.length ? ` (${details.join(', ')})` : '';
    return `${item.qty}x ${esc(item.name)}${detailStr}`;
  }).join(', ');
}

export function formatDailySummaryMessage(orders, dateStr, dueTodaySubs, todayStr) {
  const lines = [];
  lines.push(`📋 <b>Daily Order Summary — ${esc(formatCalendarDate(dateStr))}</b>`);
  lines.push(`🕐 1:30 PM – 5:59 AM next day (Cambodia Time)`);
  lines.push('');

  if (!orders.length) {
    lines.push('No new orders were placed in this window.');
  } else {
    let paidTotal = 0;
    orders.forEach((order, i) => {
      const isSub = order.orderType === 'subscription';
      const itemsSummary = summarizeItems(order.items);
      const custObj = order.customer || {};
      const name = [custObj.firstName, custObj.lastName].filter(Boolean).join(' ') || 'Customer';
      const statusIcon = order.status === 'paid' ? '✅ Paid' : order.status === 'unpaid' ? '❌ Not received' : '⏳ Pending';
      const pickupLabel = pickupSlotLabel(order);
      const typeTag = isSub ? ` (Subscription, ${order.subDays || ''}d, starts ${esc(formatCalendarDate(order.subStartDate))})` : (pickupLabel ? ` (${pickupLabel})` : '');
      let line = `${i + 1}. <b>${esc(order.orderCode || '')}</b> — ${esc(name)} — ${itemsSummary}${typeTag} — $${money(order.total)} — ${statusIcon}`;
      if (order.remark) line += `\n   📝 ${esc(order.remark)}`;
      lines.push(line);
      if (order.status === 'paid') paidTotal += Number(order.total) || 0;
    });
    lines.push('');
    lines.push(`Total orders: ${orders.length}`);
    lines.push(`Total revenue (paid): $${money(paidTotal)}`);
  }

  // Ongoing subscribers whose schedule includes today, regardless of when
  // they originally signed up -- the overnight order-timestamp window above
  // only ever catches a subscription once, on the day it was created, so
  // without this every later day of an active subscription would silently
  // disappear from staff's morning prep list.
  lines.push('');
  lines.push(`☕ <b>Subscriptions due ${esc(formatCalendarDate(todayStr))}</b>`);
  if (!dueTodaySubs || !dueTodaySubs.length) {
    lines.push('None.');
  } else {
    dueTodaySubs.forEach((order, i) => {
      const item = order.items && order.items[0];
      const itemsSummary = item ? summarizeItems([Object.assign({}, item, { qty: 1 })]) : '';
      const custObj = order.customer || {};
      const name = [custObj.firstName, custObj.lastName].filter(Boolean).join(' ') || 'Customer';
      lines.push(`${i + 1}. <b>${esc(order.orderCode || '')}</b> — ${esc(name)} — ${itemsSummary}`);
    });
  }

  return lines.join('\n');
}

export function orderToSheetRow(order) {
    const customerObj = order.customer || {};
    const name = [customerObj.firstName, customerObj.lastName].filter(Boolean).join(' ');
    const itemsSummary = Array.isArray(order.items)
      ? order.items.map((item) => `${item.qty}x ${item.name}`).join(', ')
          : '';
    let confirmedBy = order.confirmedByName || '';
    if (!confirmedBy && order.bankRef) {
          confirmedBy = order.bankPayer ? `Bank (${order.bankPayer})` : 'Bank auto-confirm';
    }
    const isSub = order.orderType === 'subscription';
    return {
          orderCode: order.orderCode || '',
          orderType: isSub ? 'Subscription' : 'Single',
          dateTime: formatTimestamp(order.timestamp),
          customer: name,
          username: customerObj.username ? `@${customerObj.username}` : '',
          items: itemsSummary,
          subtotal: money(order.subtotal),
          discount: money(order.discount),
          total: money(order.total),
          status: order.status || '',
          confirmedBy,
          remark: order.remark || '',
          subStartDate: isSub && order.subStartDate ? formatCalendarDate(order.subStartDate) : '',
          subValidUntil: isSub && order.subValidUntil ? formatCalendarDate(order.subValidUntil) : '',
          subDays: isSub ? (order.subDays || '') : '',
    };
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
          let suffix = '';
          if (order.bankRef) {
                  const payerPart = order.bankPayer ? `, from ${esc(order.bankPayer)}` : '';
                  suffix = ` — auto-confirmed via bank alert (Ref: ${esc(order.bankRef)}${payerPart})`;
          } else if (order.confirmedByName) {
                  suffix = ' — confirmed by ' + esc(order.confirmedByName);
          }
          return `💰 Status: ✅ Paid${suffix}`;
    }
    if (order.status === 'unpaid') {
          return `💰 Status: ❌ Not received${order.confirmedByName ? ' — marked by ' + esc(order.confirmedByName) : ''}`;
    }
    return '💰 Status: ⏳ Awaiting payment confirmation';
}

function customerStatusLine(order) {
    if (order.status === 'paid') return '✅ Payment Done';
    if (order.status === 'unpaid') return '⚠️ Payment Not Received — please contact us';
    return '🟡 Payment Pending';
}

function subscriptionDrinkLine(order) {
    const item = order.items && order.items[0];
    if (!item) return '';
    const details = [];
    if (item.sugar) details.push(`${esc(item.sugar)} sugar`);
    if (item.addons && item.addons.length) details.push(item.addons.map(esc).join(', '));
    const detailStr = details.length ? ` (${details.join(', ')})` : '';
    return `☕ ${esc(item.name)}${detailStr} — $${money(item.unitPrice)}/day`;
}

function tagFreeDate(dateLabel, dateStr, order) {
    return (order.subFreeDate && dateStr === order.subFreeDate) ? `${dateLabel} 🎁Free` : dateLabel;
}

function subscriptionGroupLines(order) {
    const lines = [subscriptionDrinkLine(order)];
    const totalDays = Array.isArray(order.subDates) ? order.subDates.length : (order.subDays || 0);
    lines.push(`📅 ${esc(formatCalendarDate(order.subStartDate))} → ${esc(formatCalendarDate(order.subValidUntil))} (${totalDays} day${totalDays === 1 ? '' : 's'})`);
    if (order.subFreeDate) lines.push(`🎁 ${esc(formatCalendarDateShort(order.subFreeDate))} is free — redeemed from loyalty reward`);
    if (order.status === 'paid' && Array.isArray(order.subDates)) {
          const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates : [];
          const checklist = order.subDates.map((d) => {
                  const label = `${formatCalendarDateShort(d)}${redeemed.indexOf(d) !== -1 ? '✅' : '⬜'}`;
                  return esc(tagFreeDate(label, d, order));
          }).join('  ');
          lines.push(`Redemption: ${checklist}`);
    }
    return lines;
}

export function formatGroupMessage(order) {
    if (order.orderType === 'subscription') return formatSubscriptionGroupMessage(order);

  const lines = [];
    lines.push(`🧾 <b>New order — ${esc(order.orderCode || '')}</b>`);
    const pickupLabel = pickupSlotLabel(order);
    if (pickupLabel) lines.push(`🕐 Deliver by: <b>${pickupLabel}</b>`);
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

function formatSubscriptionGroupMessage(order) {
    const lines = [];
    lines.push(`📅 <b>New subscription — ${esc(order.orderCode || '')}</b>`);
    lines.push('');
    lines.push(...subscriptionGroupLines(order));
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

export function groupKeyboard(orderCode, status, orderType) {
    const isSub = orderType === 'subscription';
    if (status === 'paid') {
          const rows = [[{ text: '↩️ Undo (mark not received)', callback_data: 'unpaid:' + orderCode }]];
          if (isSub) rows.unshift([{ text: '☕ Redeem Today', callback_data: 'subredeem:' + orderCode }]);
          return { inline_keyboard: rows };
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
    if (order.orderType === 'subscription') return formatSubscriptionReceiptMessage(order);

  const lines = [];
    lines.push(`✅ <b>Order confirmed!</b>`);
    lines.push(`Inv. ID: <b>${esc(order.orderCode || '')}</b>`);
    lines.push(`Order Time: ${esc(formatTimestamp(order.timestamp))}`);
    const pickupLabel = pickupSlotLabel(order);
    if (pickupLabel) lines.push(`🕐 Deliver by: <b>${pickupLabel}</b>`);
    lines.push('');
    lines.push(...itemLines(order));
    lines.push('');
    lines.push(`Subtotal: $${money(order.subtotal)}`);
    if (order.redeemedFreeCup && order.discount) lines.push(`Free cup reward: −$${money(order.discount)}`);
    lines.push(`<b>Total: $${money(order.total)}</b>`);
    lines.push('');
    lines.push('✅ Order Accepted');
    lines.push(customerStatusLine(order));
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

function formatSubscriptionReceiptMessage(order) {
    const lines = [];
    lines.push(`✅ <b>Subscription confirmed!</b>`);
    lines.push(`Inv. ID: <b>${esc(order.orderCode || '')}</b>`);
    lines.push(`Order Time: ${esc(formatTimestamp(order.timestamp))}`);
    lines.push('');
    lines.push(subscriptionDrinkLine(order));
    lines.push(`Subtotal: $${money(order.subtotal)}`);
    if (order.redeemedFreeCup && order.discount) lines.push(`Free cup reward: −$${money(order.discount)}`);
    lines.push(`<b>Total: $${money(order.total)}</b>`);
    lines.push('');
    lines.push('✅ Order Accepted');
    lines.push(customerStatusLine(order));
    lines.push('');
    const dateList = (order.subDates || []).map((d) => tagFreeDate(formatCalendarDateShort(d), d, order)).join(', ');
    lines.push(`Your Subscription valid until ${esc(formatCalendarDate(order.subValidUntil))}: ${esc(dateList)}`);
    if (order.subFreeDate) lines.push(`🎁 ${esc(formatCalendarDateShort(order.subFreeDate))} is free — redeemed from your loyalty reward!`);
    lines.push('');
    lines.push('Thank you for subscribing to 7Teen Café! 💙');

  return lines.join('\n');
}
