import { getRedis } from '../lib/redis.js';

async function getValidStravaToken() {
  const redis = await getRedis();

  // Check Redis for a non-expired token first
  const stored = await redis.get('trainai:strava:token');
  if (stored) {
    const { access_token, expires_at } = JSON.parse(stored);
    if (Date.now() / 1000 < expires_at - 60) return access_token;
  }

  // Fall back to env var token if still valid
  const envToken = process.env.STRAVA_API_TOKEN;
  const envExpiry = parseInt(process.env.STRAVA_TOKEN_EXPIRES_AT ?? '0', 10);
  if (envToken && Date.now() / 1000 < envExpiry - 60) return envToken;

  // Refresh the token
  const refreshRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
    }),
  });

  if (!refreshRes.ok) throw new Error(`Strava token refresh failed: ${refreshRes.status}`);
  const refreshed = await refreshRes.json();

  await redis.set(
    'trainai:strava:token',
    JSON.stringify({ access_token: refreshed.access_token, expires_at: refreshed.expires_at }),
    { EX: 21600 }
  );

  return refreshed.access_token;
}

export default async function handler(req, res) {
  try {
    const token = await getValidStravaToken();
    const headers = { Authorization: `Bearer ${token}` };

    const sevenDaysAgo = Math.floor((Date.now() - 7 * 86400000) / 1000);
    const activitiesRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${sevenDaysAgo}&per_page=20`,
      { headers }
    );

    if (!activitiesRes.ok) throw new Error(`Strava API error: ${activitiesRes.status}`);
    const activities = await activitiesRes.json();

    // Normalize each activity for the coaching engine
    const classified = activities.map(a => ({
      id: a.id,
      date: a.start_date_local?.split('T')[0],
      name: a.name,
      type: a.sport_type ?? a.type,
      duration_minutes: Math.round((a.moving_time ?? 0) / 60),
      distance_miles: a.distance ? Math.round((a.distance / 1609.34) * 10) / 10 : 0,
      elevation_gain_ft: a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.281) : 0,
      calories: a.calories ?? null,
      source: 'strava',
    }));

    // Store in Redis keyed by date for the coach engine
    const redis = await getRedis();
    const byDate = {};
    classified.forEach(a => { if (!byDate[a.date]) byDate[a.date] = []; byDate[a.date].push(a); });
    for (const [date, acts] of Object.entries(byDate)) {
      await redis.set(`trainai:strava:${date}`, JSON.stringify(acts), { EX: 86400 * 8 });
    }

    res.status(200).json({ activities: classified, count: classified.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
