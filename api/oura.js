export default async function handler(req, res) {
  const token = process.env.OURA_API_TOKEN;
  if (!token) return res.status(400).json({ error: 'Missing OURA_API_TOKEN' });

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterdayStr = new Date(today - 86400000).toISOString().split('T')[0];
  const sevenDaysAgoStr = new Date(today - 7 * 86400000).toISOString().split('T')[0];

  const h = { Authorization: `Bearer ${token}` };

  try {
    // Fetch all data sources in parallel
    const [
      sleepRes, readinessRes, activityRes,
      sleepSessionRes, heartRateRes, spo2Res,
      sleepTrendRes, readinessTrendRes,
    ] = await Promise.all([
      fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers: h }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers: h }),
      fetch(`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers: h }),
      // Detailed sleep session with stages breakdown
      fetch(`https://api.ouraring.com/v2/usercollection/sleep?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers: h }),
      // Heart rate data from last night (for resting HR variation explanation)
      fetch(`https://api.ouraring.com/v2/usercollection/heartrate?start_datetime=${yesterdayStr}T20:00:00&end_datetime=${todayStr}T12:00:00`, { headers: h }),
      // Blood oxygen
      fetch(`https://api.ouraring.com/v2/usercollection/daily_spo2?start_date=${yesterdayStr}&end_date=${todayStr}`, { headers: h }),
      // 7-day trend for sleep
      fetch(`https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=${sevenDaysAgoStr}&end_date=${todayStr}`, { headers: h }),
      // 7-day trend for readiness
      fetch(`https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${sevenDaysAgoStr}&end_date=${todayStr}`, { headers: h }),
    ]);

    const [
      sleepData, readinessData, activityData,
      sleepSessionData, heartRateData, spo2Data,
      sleepTrendData, readinessTrendData,
    ] = await Promise.all([
      sleepRes.json(), readinessRes.json(), activityRes.json(),
      sleepSessionRes.json(), heartRateRes.json(), spo2Res.json(),
      sleepTrendRes.json(), readinessTrendRes.json(),
    ]);

    const sleep = sleepData.data?.at(-1) ?? null;
    const readiness = readinessData.data?.at(-1) ?? null;
    const activity = activityData.data?.at(-1) ?? null;
    const sleepSession = sleepSessionData.data?.at(-1) ?? null;
    const spo2 = spo2Data.data?.at(-1) ?? null;

    // Resting HR: find minimum HR during sleep window (approx 1-5am)
    const hrItems = heartRateData.data ?? heartRateData.items ?? [];
    const restingHrSamples = hrItems
      .filter(d => { const h = new Date(d.timestamp).getUTCHours(); return h >= 1 && h <= 5; })
      .map(d => d.bpm)
      .filter(Boolean);
    const restingHrMin = restingHrSamples.length ? Math.min(...restingHrSamples) : null;
    const restingHrAvg = restingHrSamples.length
      ? Math.round(restingHrSamples.reduce((a, b) => a + b, 0) / restingHrSamples.length)
      : null;

    // HR variation pattern: group by hour for the sleep window
    const hrByHour = {};
    hrItems.forEach(d => {
      const hr = new Date(d.timestamp).getUTCHours();
      if (!hrByHour[hr]) hrByHour[hr] = [];
      hrByHour[hr].push(d.bpm);
    });
    const hrTimeline = Object.entries(hrByHour)
      .sort(([a], [b]) => a - b)
      .map(([hour, bpms]) => ({
        hour: parseInt(hour),
        avg_bpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
      }));

    // 7-day sleep score trend
    const sleepTrend = (sleepTrendData.data ?? []).map(d => ({
      date: d.day,
      score: d.score,
      hours: d.total_sleep_duration ? Math.round(d.total_sleep_duration / 360) / 10 : null,
    }));

    // 7-day readiness trend
    const readinessTrend = (readinessTrendData.data ?? []).map(d => ({
      date: d.day,
      score: d.score,
      hrv_balance: d.contributors?.hrv_balance ?? null,
    }));

    const totalSleepHours = sleep?.total_sleep_duration
      ? Math.round(sleep.total_sleep_duration / 360) / 10
      : null;

    res.status(200).json({
      sleep: {
        score: sleep?.score ?? null,
        hours: totalSleepHours,
        efficiency: sleep?.contributors?.efficiency ?? null,
        deep_score: sleep?.contributors?.deep_sleep ?? null,
        rem_score: sleep?.contributors?.rem_sleep ?? null,
        restfulness: sleep?.contributors?.restfulness ?? null,
        latency: sleep?.contributors?.sleep_latency ?? null,
        timing: sleep?.contributors?.sleep_timing ?? null,
        // Detailed stages from sleep session
        rem_minutes: sleepSession?.rem_sleep_duration ? Math.round(sleepSession.rem_sleep_duration / 60) : null,
        deep_minutes: sleepSession?.deep_sleep_duration ? Math.round(sleepSession.deep_sleep_duration / 60) : null,
        light_minutes: sleepSession?.light_sleep_duration ? Math.round(sleepSession.light_sleep_duration / 60) : null,
        awake_minutes: sleepSession?.awake_duration ? Math.round(sleepSession.awake_duration / 60) : null,
        bedtime_start: sleepSession?.bedtime_start ?? null,
        bedtime_end: sleepSession?.bedtime_end ?? null,
      },
      readiness: {
        score: readiness?.score ?? null,
        hrv_balance: readiness?.contributors?.hrv_balance ?? null,
        recovery_index: readiness?.contributors?.recovery_index ?? null,
        resting_heart_rate: readiness?.contributors?.resting_heart_rate ?? null,
        body_temperature: readiness?.contributors?.body_temperature ?? null,
        previous_day_activity: readiness?.contributors?.previous_day_activity ?? null,
        sleep_balance: readiness?.contributors?.sleep_balance ?? null,
        // HRV and resting HR values
        hrv_average: readiness?.hrv_average ?? null,
        resting_hr_value: restingHrAvg,
        resting_hr_min: restingHrMin,
      },
      activity: {
        score: activity?.score ?? null,
        steps: activity?.steps ?? null,
        active_calories: activity?.active_calories ?? null,
        total_calories: activity?.total_calories ?? null,
        sedentary_minutes: activity?.sedentary_time ? Math.round(activity.sedentary_time / 60) : null,
        high_activity_minutes: activity?.high_activity_time ? Math.round(activity.high_activity_time / 60) : null,
      },
      heart_rate: {
        resting_avg: restingHrAvg,
        resting_min: restingHrMin,
        timeline: hrTimeline,
      },
      spo2: {
        average: spo2?.spo2_percentage?.average ?? null,
        breathing_disturbance: spo2?.breathing_disturbance_index ?? null,
      },
      trends: {
        sleep: sleepTrend,
        readiness: readinessTrend,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
