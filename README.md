# 7Teen Café Mini App — v2 (new design)

This replaces the previous version with the updated design: category tabs, item
detail with sugar level & add-ons, cart with a "free cup" loyalty reward, a
KHQR payment step, and an order-status confirmation screen.

## Files

- `index.html` — the whole app (menu, item detail, cart, KHQR payment,
  confirmation, rewards). No build step, no framework.
- `api/order.js` — Vercel serverless function that sends the order to the
  shop owner's Telegram via the Bot API.
- `assets/7Teen_Logo.png`, `assets/khqr.jpg` — logo and your real Canadia
  Bank KHQR code image.
- `package.json` — minimal, no dependencies (uses Node 18's built-in `fetch`).

## Environment variables (Vercel → Settings → Environment Variables)

- `BOT_TOKEN` — your bot's token from @BotFather
- `OWNER_CHAT_ID` — your chat ID from @userinfobot

These should already be set from the previous deployment — no changes needed
unless you're setting up fresh.

## Menu data

Menu items, prices, and categories live in the `MENU` array near the top of
the `<script>` block in `index.html`. Each item has a `photo` field (currently
`null`, showing a placeholder) — once you send over the drink photos, set
`photo: "assets/your-photo.jpg"` for each item and drop the image files into
`assets/`.

## What changed from v1

- Menu is now organized into Coffee / Tea / Pastries / Food tabs
- Item detail screen with sugar level (drinks only) and Extra Shot add-on
- Loyalty stamp card: buy 6 cups, 7th is free — tracked client-side per
  session (no database, resets on page reload, same as before)
- Cart lets you redeem an available free cup (auto-discounts the priciest
  item in the bag)
- New KHQR payment screen between cart and confirmation, showing your real
  Canadia Bank QR code and the amount due
- Confirmation screen shows a pickup code and a simulated
  received → preparing → ready status timeline
- Uses Telegram's native MainButton/BackButton when running inside Telegram,
  falling back to on-screen buttons if opened in a regular browser for testing
