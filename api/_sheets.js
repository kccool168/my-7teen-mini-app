// Fire-and-await helpers for pushing order data to the Google Sheets
// order-log sync (a container-bound Apps Script Web App deployed on the
// "7Teen Cafe Order Reports" sheet — see docs/GOOGLE_SHEETS_SYNC.md if that
// exists, otherwise ask whoever set up GOOGLE_SHEETS_WEBHOOK_URL).
//
// Both helpers are silent no-ops if GOOGLE_SHEETS_WEBHOOK_URL isn't
// configured, and never throw — a sheet-sync hiccup must never block or
// fail an order or a status update. Errors are only logged.
import { orderToSheetRow } from './_format.js';

export async function pushOrderToSheet(order) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'appendOrder', order: orderToSheetRow(order) }),
    });
  } catch (err) {
    console.error('Sheet sync (appendOrder) failed', err);
  }
}

export async function pushStatusToSheet(orderCode, status, confirmedBy, extra) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url || !orderCode) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: 'updateStatus', orderCode, status, confirmedBy: confirmedBy || '' }, extra || {})),
    });
  } catch (err) {
    console.error('Sheet sync (updateStatus) failed', err);
  }
}

export async function pushLoyaltyToSheet(customer, stamps, freeCups, lastCupPrice) {
    const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (!url || !customer || customer.id == null) return;
    try {
          await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                            action: 'upsertLoyalty',
                            customerId: String(customer.id),
                            customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
                            username: customer.username ? '@' + customer.username : '',
                            stamps, freeCups,
                            lastCupPrice: lastCupPrice != null ? lastCupPrice : null,
                  }),
          });
    } catch (err) {
          console.error('Sheet sync (upsertLoyalty) failed', err);
    }
}
