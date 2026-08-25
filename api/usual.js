import getClient from './_redis.js';

// Returns the customer's most-ordered drink (by cup count across all past
// orders), so the Home screen can offer a one-tap "Your usual" reorder.
// Matches items by name (orders store the item's display name, not its
// MENU id), so the client re-resolves the id by name once it gets a hit.
export default async function handler(req, res) {
  try {
    var userId = String((req.query && req.query.userId) || '');
    if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });
    var client = await getClient();
    var counts = {};
    for await (const key of client.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
      var raw = await client.get(key);
      if (!raw) continue;
      var order;
      try { order = JSON.parse(raw); } catch (e) { continue; }
      var c = order.customer || {};
      if (c.id == null || String(c.id) !== userId) continue;
      (order.items || []).forEach(function (it) {
        var name = it.name;
        if (!name) return;
        if (!counts[name]) counts[name] = { count: 0, sugar: {} };
        counts[name].count += Number(it.qty) || 1;
        if (it.sugar) counts[name].sugar[it.sugar] = (counts[name].sugar[it.sugar] || 0) + 1;
      });
    }
    var best = null;
    Object.keys(counts).forEach(function (name) {
      if (!best || counts[name].count > counts[best].count) best = name;
    });
    if (!best) return res.status(200).json({ ok: true, usual: null });
    var info = counts[best];
    var topSugar = Object.keys(info.sugar).sort(function (a, b) { return info.sugar[b] - info.sugar[a]; })[0] || null;
    return res.status(200).json({ ok: true, usual: { name: best, sugar: topSugar, count: info.count } });
  } catch (err) {
    console.error('usual endpoint failed', err);
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
