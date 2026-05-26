import { getRedis } from '../lib/redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();
  const today = new Date().toISOString().split('T')[0];

  if (req.method === 'POST') {
    const { event } = req.body ?? {};
    if (event !== 'vasa_checkin') return res.status(400).json({ success: false, message: 'Invalid event type' });

    const data = {
      event: 'vasa_checkin',
      gym: 'VASA FITNESS',
      timestamp: new Date().toISOString(),
      detected: true,
    };

    // Persist in Redis — expires at midnight tonight
    const secondsUntilMidnight = 86400 - (Math.floor(Date.now() / 1000) % 86400);
    await redis.set(`trainai:workout:${today}`, JSON.stringify(data), { EX: secondsUntilMidnight + 3600 });

    return res.status(200).json({ success: true, message: 'Check-in detected', data });
  }

  if (req.method === 'GET') {
    const raw = await redis.get(`trainai:workout:${today}`);
    const data = raw ? JSON.parse(raw) : null;
    return res.status(200).json({ success: true, data, detected: !!data });
  }

  res.status(405).json({ message: 'Method not allowed' });
}
