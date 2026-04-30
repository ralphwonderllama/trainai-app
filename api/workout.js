// Serverless function to handle workout check-in from iOS Shortcut
// Endpoint: POST /api/workout
// Expected body: {"event": "vasa_checkin"}

const checkInData = {};

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'POST') {
    const { event } = req.body;

    if (event === 'vasa_checkin') {
      const today = new Date().toISOString().split('T')[0];

      checkInData[today] = {
        event: 'vasa_checkin',
        gym: 'VASA FITNESS',
        timestamp: new Date().toISOString(),
        detected: true
      };

      return res.status(200).json({
        success: true,
        message: 'Check-in detected',
        data: checkInData[today]
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Invalid event type'
    });
  }

  if (req.method === 'GET') {
    const today = new Date().toISOString().split('T')[0];
    const todayData = checkInData[today] || null;

    return res.status(200).json({
      success: true,
      data: todayData,
      detected: !!todayData
    });
  }

  res.status(405).json({ message: 'Method not allowed' });
}
