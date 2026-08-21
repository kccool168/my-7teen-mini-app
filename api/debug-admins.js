export default async function handler(req, res) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
  if (!BOT_TOKEN || !GROUP_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'Missing env vars' });
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatAdministrators?chat_id=${GROUP_CHAT_ID}`);
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
