import { getRedis } from '../lib/redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();

  if (req.method === 'POST') {
    const { weight_lb, date } = req.body ?? {};
    if (!weight_lb) return res.status(400).json({ error: 'weight_lb required' });

    const entry = {
      weight_lb: parseFloat(weight_lb),
      date: date ?? new Date().toISOString().split('T')[0],
      recorded_at: new Date().toISOString(),
    };

    // Store latest and also in history list
    await redis.set('trainai:weight:latest', JSON.stringify(entry), { EX: 86400 * 90 });
    await redis.lPush('trainai:weight:history', JSON.stringify(entry));
    await redis.lTrim('trainai:weight:history', 0, 49); // keep last 50 entries

    return res.status(200).json({ ok: true, entry });
  }

  if (req.method === 'GET') {
    const [latest, history] = await Promise.all([
      redis.get('trainai:weight:latest'),
      redis.lRange('trainai:weight:history', 0, 24),
    ]);

    return res.status(200).json({
      latest: latest ? JSON.parse(latest) : null,
      history: history.map(h => JSON.parse(h)),
      goal_lb: 160,
      long_term_goal_lb: 175,
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
