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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formats a plain calendar date string ('YYYY-MM-DD', no time component) as
// "11 Aug 2026". Deliberately avoids the Date object's local-timezone
// parsing quirks — subscription dates are calendar days, not instants.
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

// Same, without the year — used for the compact per-day redemption checklist.
export function formatCalendarDateShort(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const mn = MONTH_NAMES[m - 1] || '';
  return `${d} ${mn}`;
}

// Pure calendar-day arithmetic (UTC internally, no real-world instant is
// involved) so it can never drift a day depending on server timezone.
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

// Clamps a requested subscription start date server-side (defense in depth
// — never trust the client's date alone): must fall within today..+1 month,
// and must land on a day the customer actually selected (the café is also
// always closed Sundays, so 0 never appears in a valid `days` list — see
// VALID_SUB_DAYS in api/order.js). Mirrors the client's own clamp.
// dayOfWeekUTC(): 0 = Sunday ... 6 = Saturday.
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

// Given a start date and a *total* day count (paid days + any bonus free
// days), returns the list of redeemable calendar dates, skipping any day of
// the week the customer didn't select.
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

// Today's date (YYYY-MM-DD) in Cambodia local time — used for redemption
// and expiry checks so a server running in another timezone can't shift
// which calendar day "today" means.
export function todayInPhnomPenh() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Current hour/minute (0-23, 0-59) in Cambodia local time — used for
// time-of-day cutoffs like the 7:00 AM /skip deadline and the 7:00-8:00 AM
// delivery-run window during which new orders are paused.
export function nowTimePhnomPenh() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '0';
  return { hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}

// Human-readable label for a regular order's pickup slot ('morning' /
// 'afternoon'), or '' if missing/unrecognized (e.g. older orders placed
// before this field existed, or subscriptions, which don't use it).
function pickupSlotLabel(order) {
  return order.pickupSlot === 'morning' ? 'Morning' : order.pickupSlot === 'afternoon' ? 'Afternoon' : '';
}

// Builds the daily consolidated order report sent to the staff group each
// morning (see api/daily-order-summary.js) — every order placed from
// 1:30 PM on the given Phnom Penh calendar day through 6:29 AM the next
// morning (i.e. right up until this report is sent), so there's no
// overnight gap between reports.
export function formatDailySummaryMessage(orders, dateStr) {
  const lines = [];
  lines.push(`📋 <b>Daily Order Summary — ${esc(formatCalendarDate(dateStr))}</b>`);
  lines.push(`🕐 1:30 PM – 5:59 AM next day (Cambodia Time)`);
  lines.push('');

  if (!orders.length) {
    lines.push('No orders were placed in this window.');
    return lines.join('\n');
  }

  let paidTotal = 0;
  orders.forEach((order, i) => {
    const isSub = order.orderType === 'subscription';
    const itemsSummary = Array.isArray(order.items)
      ? order.items.map((item) => {
        const addonStr = (item.addons && item.addons.length) ? ` (${item.addons.map(esc).join(', ')})` : '';
        return `${item.qty}x ${esc(item.name)}${addonStr}`;
      }).join(', ')
      : '';
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

  return lines.join('\n');
}

// Shapes an internal order record into the flat object the Google Sheets
// order-log sync (Apps Script Web App) expects — one row per order across
// the sheet's 15 columns. Shared by api/all-orders.js (bulk historical
// export) and the per-order sync calls from api/order.js and
// api/telegram-webhook.js, so every path produces identically-shaped rows.
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

// Staff-facing status line — unchanged wording, used in the group report for
// both regular orders and subscriptions.
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

// Customer-facing status wording — the simplified 3-state model requested:
// Order Accepted (always true once they have a receipt) + Payment Pending /
// Payment Done / Payment Not Received.
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

// Subscription block for the staff group report: drink, date range, and —
// once paid — a per-day redemption checklist so staff can see at a glance
// which days have already been picked up.
function subscriptionGroupLines(order) {
  const lines = [subscriptionDrinkLine(order)];
  const bonus = order.subBonusDays || 0;
  const totalDays = Array.isArray(order.subDates) ? order.subDates.length : ((order.subDays || 0) + bonus);
  lines.push(`📅 ${esc(formatCalendarDate(order.subStartDate))} → ${esc(formatCalendarDate(order.subValidUntil))} (${totalDays} day${totalDays === 1 ? '' : 's'}${bonus ? `, incl. ${bonus} free` : ''})`);
  if (bonus > 0) lines.push(`🎁 +${bonus} free day${bonus === 1 ? '' : 's'} from loyalty reward`);
  if (order.status === 'paid' && Array.isArray(order.subDates)) {
    const redeemed = Array.isArray(order.subRedeemedDates) ? order.subRedeemedDates : [];
    const checklist = order.subDates.map((d) => `${formatCalendarDateShort(d)}${redeemed.indexOf(d) !== -1 ? '✅' : '⬜'}`).join('  ');
    lines.push(`Redemption: ${checklist}`);
  }
  return lines;
}

// The report sent to the staff group, plus its inline-button footer.
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
// remaining button lets staff flip it back (in case of a mis-tap). Paid
// subscriptions also get a "Redeem Today" button so staff can mark off each
// day's pickup.
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
  lines.push(`<b>Total: $${money(order.total)}</b>`);
  lines.push('');
  lines.push('✅ Order Accepted');
  lines.push(customerStatusLine(order));
  lines.push('');
  lines.push(`Your Subscription valid until ${esc(formatCalendarDate(order.subValidUntil))}: ${esc((order.subDates || []).map(formatCalendarDateShort).join(', '))}`);
  if (order.subBonusDays) lines.push(`🎁 Includes ${order.subBonusDays} free day${order.subBonusDays === 1 ? '' : 's'} from your loyalty reward!`);
  lines.push('');
  lines.push('Thank you for subscribing to 7Teen Café! 💙');

  return lines.join('\n');
}
