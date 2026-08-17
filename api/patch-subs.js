// TEMPORARY one-off: GET /api/patch-subs
// Applies two shop-owner-requested edits to specific active subscription
// order records in Redis:
//   1. order:7T-1075 (@cphana) -- move date range to 17-21 Aug 2026.
//   2. order:7T-1071 (@rithyyyyyy) -- change drink to Ice Latte, sugar 0%.
// Verifies the customer username before touching each record. Delete this
// file once no longer needed.
import getClient from './_redis.js';

const ORDER_TTL_SECONDS = 60 * 60 * 24 * 14;

export default async function handler(req, res) {
let client;
try {
client = await getClient();
} catch (err) {
return res.status(500).json({ ok: false, error: 'Database unavailable' });
}

const report = {};

try {
const raw1 = await client.get('order:7T-1075');
if (!raw1) {
report.cphana = { ok: false, error: 'order:7T-1075 not found' };
} else {
const order1 = JSON.parse(raw1);
const uname1 = order1.customer && order1.customer.username ? String(order1.customer.username).toLowerCase() : '';
if (uname1 !== 'cphana') {
report.cphana = { ok: false, error: 'username mismatch: ' + uname1 };
} else {
const before = { subStartDate: order1.subStartDate, subDates: order1.subDates, subValidUntil: order1.subValidUntil };
order1.subStartDate = '2026-08-17';
order1.subDates = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'];
order1.subValidUntil = '2026-08-21';
await client.set('order:7T-1075', JSON.stringify(order1), { EX: ORDER_TTL_SECONDS });
report.cphana = { ok: true, before, after: { subStartDate: order1.subStartDate, subDates: order1.subDates, subValidUntil: order1.subValidUntil } };
}
}
} catch (err) {
report.cphana = { ok: false, error: String(err) };
}

try {
const raw2 = await client.get('order:7T-1071');
if (!raw2) {
report.rithyyyyyy = { ok: false, error: 'order:7T-1071 not found' };
} else {
const order2 = JSON.parse(raw2);
const uname2 = order2.customer && order2.customer.username ? String(order2.customer.username).toLowerCase() : '';
if (uname2 !== 'rithyyyyyy') {
report.rithyyyyyy = { ok: false, error: 'username mismatch: ' + uname2 };
} else {
const before = JSON.parse(JSON.stringify(order2.items[0]));
order2.items[0].name = 'Ice Latte';
order2.items[0].sugar = '0%';
await client.set('order:7T-1071', JSON.stringify(order2), { EX: ORDER_TTL_SECONDS });
report.rithyyyyyy = { ok: true, before, after: order2.items[0] };
}
}
} catch (err) {
report.rithyyyyyy = { ok: false, error: String(err) };
}

return res.status(200).json({ ok: true, report });
}
