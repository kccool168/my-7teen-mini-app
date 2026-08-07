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

export async function pushStatusToSheet(orderCode, status, confirmedBy) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url || !orderCode) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateStatus', orderCode, status, confirmedBy: confirmedBy || '' }),
    });
  } catch (err) {
    console.error('Sheet sync (updateStatus) failed', err);
  }
}
