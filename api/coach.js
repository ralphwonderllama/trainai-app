import Anthropic from '@anthropic-ai/sdk';
import { getRedis } from '../lib/redis.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const calorieEngine = JSON.parse(
  readFileSync(join(__dirname, '../knowledge/dynamic_calorie_engine.json'), 'utf-8')
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Classify today's day type based on activities and gym check-in
function classifyDayType(activities = [], gymDetected = false) {
  if (!activities.length && !gymDetected) return 'rest_low_activity_day';

  const hasEndurance = activities.some(a =>
    ['Run', 'Ride', 'Hike', 'Trail Run', 'VirtualRide', 'Walk'].includes(a.type)
  );

  const totalDuration = activities.reduce((s, a) => s + (a.duration_minutes ?? 0), 0);
  const maxElevation = Math.max(...activities.map(a => a.elevation_gain_ft ?? 0), 0);
  const maxDistance = Math.max(...activities.map(a => a.distance_miles ?? 0), 0);

  const eng = calorieEngine.activity_classification;

  // Heavy endurance check
  if (hasEndurance && (
    totalDuration >= eng.heavy_endurance_heuristics.duration_minutes[0] ||
    maxElevation >= eng.heavy_endurance_heuristics.elevation_gain_ft[0] ||
    maxDistance >= eng.heavy_endurance_heuristics.hiking_distance_miles[0]
  )) return 'heavy_endurance_or_long_elevation_day';

  // Moderate endurance check
  if (hasEndurance && (
    totalDuration >= eng.moderate_endurance_heuristics.duration_minutes[0] ||
    maxElevation >= eng.moderate_endurance_heuristics.elevation_gain_ft[0]
  )) return 'moderate_endurance_day';

  // Lift + high walking (gym + endurance combo)
  if (gymDetected && hasEndurance) return 'lift_plus_high_walking_day';

  // Lift day
  if (gymDetected) return 'lift_day';

  return 'rest_low_activity_day';
}

function getTargetsForDayType(dayType) {
  return calorieEngine.daily_target_categories[dayType] ?? calorieEngine.daily_target_categories.rest_low_activity_day;
}

// Build the full coaching prompt with all available data
function buildPrompt(data) {
  const { oura, nutrition, activities, gymDetected, weight, dayType, targets } = data;

  return `You are TrainAI, a personalized health and performance coach. You know this athlete deeply.

## Athlete Profile
- Male, age 51, current weight ~${weight ?? 147} lb
- Goal: gain lean mass to 160 lb (then 175 lb long-term)
- Training identity: hybrid athlete — lifts 2-5x/week AND cycles, hikes, trail runs
- Dietary constraints: gluten-free, low lactose, mostly dairy-free
- Core problem: chronic under-fueling, especially on untracked days and high-output days
- He eats more when he sees visible targets — always show specific numbers

## Today's Activity Data
Day type classified as: **${dayType.replace(/_/g, ' ').toUpperCase()}**
Gym check-in detected: ${gymDetected ? 'YES (VASA FITNESS)' : 'No'}
Strava activities today: ${activities.length ? JSON.stringify(activities, null, 2) : 'None recorded'}

## Today's Nutrition (from MacrosFirst or manual entry)
${nutrition ? `
- Calories logged: ${nutrition.calories} kcal
- Protein: ${nutrition.protein_g}g
- Carbs: ${nutrition.carbs_g}g
- Fat: ${nutrition.fat_g}g
- Source: ${nutrition.source}
` : 'No nutrition data logged today yet.'}

## Today's Dynamic Targets (based on activity)
- Calories: ${targets.calories_kcal[0]}–${targets.calories_kcal[1]} kcal
- Protein: ${targets.protein_g[0]}–${targets.protein_g[1]}g
- Carbs: ${targets.carbs_g[0]}–${targets.carbs_g[1]}g
- Fat: ${targets.fat_g[0]}–${targets.fat_g[1]}g

## Oura Ring Data (last night)
${oura ? `
Sleep:
- Score: ${oura.sleep?.score ?? '—'}/100
- Hours: ${oura.sleep?.hours ?? '—'}h
- Deep sleep: ${oura.sleep?.deep_minutes ?? '—'} min
- REM sleep: ${oura.sleep?.rem_minutes ?? '—'} min
- Light sleep: ${oura.sleep?.light_minutes ?? '—'} min
- Awake: ${oura.sleep?.awake_minutes ?? '—'} min
- Efficiency: ${oura.sleep?.efficiency ?? '—'}

Readiness:
- Score: ${oura.readiness?.score ?? '—'}/100
- HRV balance: ${oura.readiness?.hrv_balance ?? '—'}
- Resting HR: ${oura.heart_rate?.resting_avg ?? '—'} bpm (min: ${oura.heart_rate?.resting_min ?? '—'} bpm)
- Recovery index: ${oura.readiness?.recovery_index ?? '—'}
- Sleep balance: ${oura.readiness?.sleep_balance ?? '—'}

Heart Rate Timeline (during sleep):
${JSON.stringify(oura.heart_rate?.timeline ?? [], null, 2)}

SpO2: ${oura.spo2?.average ?? '—'}%

7-Day Sleep Trend: ${JSON.stringify(oura.trends?.sleep ?? [], null, 2)}
7-Day Readiness Trend: ${JSON.stringify(oura.trends?.readiness ?? [], null, 2)}
` : 'Oura data unavailable.'}

## Underfueling Detection Rules (from calorie engine)
Absolute minimum: 2,800 kcal/day
Training day minimum: 3,000 kcal
Minimum for today's day type: ${calorieEngine.baseline_rules[dayType.includes('endurance') ? (dayType.includes('heavy') ? 'heavy_endurance_day_minimum_kcal' : 'moderate_endurance_day_minimum_kcal') : 'training_day_minimum_kcal'] ?? 2800} kcal

## Your Task
Generate a coaching response with exactly these three sections. Be specific, direct, and use real numbers. Do NOT use generic advice. If data is missing, say so and give the target anyway.

### NUTRITION
- State today's day type and why
- Give the exact calorie and macro targets for today
- If nutrition is logged: compare actuals to targets, identify the specific gap, recommend exactly what to eat to close it (e.g., "add a rice + chicken bowl for 600 cal / 45g protein")
- If not logged: flag as high under-fueling risk, state the target, recommend a quick meal to log now
- Use fueling/recovery language, never diet/restriction language
- Flag if 3-day recovery debt is building (if you see consecutive under-fueled days in trends)

### FITNESS
- Assess today's readiness for training based on Oura readiness score + sleep quality
- Give one specific training recommendation for today (workout type, intensity, duration)
- If gym was detected: confirm the session and suggest focus area based on readiness
- Note anything from recent Strava activities that affects today (recovery load, training gaps)

### SLEEP
- Explain last night in plain English (not just scores — what actually happened)
- Explain the resting HR pattern during sleep: what the variation means, what's normal, what to watch
- Give one specific, actionable improvement for tonight
- Keep this section honest — if sleep was good, say so; don't manufacture problems

Tone: direct, knowledgeable peer. Not a motivational poster. Not a doctor. Like a smart training partner who knows your data.`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const redis = await getRedis();
    const today = new Date().toISOString().split('T')[0];

    // Fetch all today's data from Redis in parallel
    const [nutritionRaw, workoutRaw, stravaRaw, weightRaw] = await Promise.all([
      redis.get(`trainai:nutrition:${today}`),
      redis.get(`trainai:workout:${today}`),
      redis.get(`trainai:strava:${today}`),
      redis.get('trainai:weight:latest'),
    ]);

    const nutrition = nutritionRaw ? JSON.parse(nutritionRaw) : null;
    const gymDetected = workoutRaw ? JSON.parse(workoutRaw).detected : false;
    const activities = stravaRaw ? JSON.parse(stravaRaw) : [];
    const weight = weightRaw ? JSON.parse(weightRaw).weight_lb : null;

    // Fetch fresh Oura data
    let oura = null;
    try {
      const ouraRes = await fetch(`${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/oura`);
      if (ouraRes.ok) oura = await ouraRes.json();
    } catch (_) { /* non-fatal */ }

    const dayType = classifyDayType(activities, gymDetected);
    const targets = getTargetsForDayType(dayType);

    const prompt = buildPrompt({ oura, nutrition, activities, gymDetected, weight, dayType, targets });

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const coaching = message.content[0].text;

    // Parse the three sections out of the response
    const sections = { nutrition: '', fitness: '', sleep: '' };
    const nutritionMatch = coaching.match(/###\s*NUTRITION\s*([\s\S]*?)(?=###\s*FITNESS|$)/i);
    const fitnessMatch = coaching.match(/###\s*FITNESS\s*([\s\S]*?)(?=###\s*SLEEP|$)/i);
    const sleepMatch = coaching.match(/###\s*SLEEP\s*([\s\S]*?)$/i);

    if (nutritionMatch) sections.nutrition = nutritionMatch[1].trim();
    if (fitnessMatch) sections.fitness = fitnessMatch[1].trim();
    if (sleepMatch) sections.sleep = sleepMatch[1].trim();

    res.status(200).json({
      date: today,
      day_type: dayType,
      targets,
      gym_detected: gymDetected,
      coaching: sections,
      raw: coaching,
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
