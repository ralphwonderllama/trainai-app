import { getRedis } from '../lib/redis.js';

// Goals & Adventures — persistent list of Randy's training objectives and planned events
// Stored as trainai:goals — JSON array, no TTL (these should persist indefinitely)
// Each goal: { id, title, type, target_date, notes, status, created_at, completed_at? }
// Types: trek | climb | summit | race | triathlon | cycling | ski | other

const REDIS_KEY = 'trainai:goals';

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();

  async function loadGoals() {
    const raw = await redis.get(REDIS_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  async function saveGoals(goals) {
    await redis.set(REDIS_KEY, JSON.stringify(goals));
    // No TTL — goals persist until explicitly deleted
  }

  // ── GET ──────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const goals = await loadGoals();

    // Sort: active first (by target_date asc, then no-date at end), then completed
    const active    = goals.filter(g => g.status === 'active').sort((a, b) => {
      if (!a.target_date && !b.target_date) return 0;
      if (!a.target_date) return 1;
      if (!b.target_date) return -1;
      return a.target_date.localeCompare(b.target_date);
    });
    const deferred  = goals.filter(g => g.status === 'deferred');
    const completed = goals.filter(g => g.status === 'completed')
      .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));

    return res.status(200).json({
      active,
      deferred,
      completed,
      total: goals.length,
    });
  }

  // ── POST ─────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body ?? {};
    const action = body.action ?? 'add';
    const goals = await loadGoals();

    // ── ADD ──────────────────────────────────────────────────────────────────
    if (action === 'add') {
      if (!body.title?.trim()) return res.status(400).json({ error: 'title required' });

      const goal = {
        id:          makeId(),
        title:       body.title.trim(),
        type:        body.type ?? 'other',        // trek|climb|summit|race|triathlon|cycling|ski|other
        target_date: body.target_date ?? null,    // 'YYYY-MM-DD' or null if open-ended
        notes:       body.notes ?? null,
        status:      'active',
        created_at:  new Date().toISOString(),
      };

      goals.push(goal);
      await saveGoals(goals);
      return res.status(200).json({ ok: true, goal });
    }

    // ── UPDATE STATUS ────────────────────────────────────────────────────────
    if (action === 'update') {
      const idx = goals.findIndex(g => g.id === body.id);
      if (idx === -1) return res.status(404).json({ error: 'goal not found' });

      if (body.status) goals[idx].status = body.status;
      if (body.status === 'completed') goals[idx].completed_at = new Date().toISOString();
      if (body.title)       goals[idx].title       = body.title.trim();
      if (body.target_date !== undefined) goals[idx].target_date = body.target_date;
      if (body.notes !== undefined)       goals[idx].notes       = body.notes;
      if (body.type)        goals[idx].type        = body.type;

      await saveGoals(goals);
      return res.status(200).json({ ok: true, goal: goals[idx] });
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (action === 'delete') {
      const before = goals.length;
      const filtered = goals.filter(g => g.id !== body.id);
      if (filtered.length === before) return res.status(404).json({ error: 'goal not found' });

      await saveGoals(filtered);
      return res.status(200).json({ ok: true, deleted: body.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
