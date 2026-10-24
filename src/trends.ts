import type Database from "better-sqlite3";
import { dayKeyFor } from "./time.js";

function cutoffDay(days: number, timezone: string): string {
  return dayKeyFor(new Date(Date.now() - days * 24 * 60 * 60 * 1000), timezone);
}

export function getTrends(db: Database.Database, userId: string, timezone: string): {
  weekly: Array<{ week: string; intake: number; burn: number; net: number }>;
  monthlyDeficit: number;
  topFoods: Array<{ food: string; calories: number; entries: number }>;
  glucose: Array<{ day: string; value: number }>;
} {
  const weekly = db.prepare(`
    SELECT strftime('%Y-%W', d.day_key) AS week,
      COALESCE(SUM((SELECT SUM(l.calories) FROM log_entries l WHERE l.user_id=d.user_id AND l.day_key=d.day_key AND l.status='active')), 0) AS intake,
      COALESCE(SUM(d.burn_total), 0) AS burn
    FROM days d WHERE d.user_id = ? AND d.day_key >= ?
    GROUP BY week ORDER BY week
  `).all(userId, cutoffDay(84, timezone)) as Array<{ week: string; intake: number; burn: number }>;
  const topFoods = db.prepare(`
    SELECT display_name AS food, SUM(calories) AS calories, COUNT(*) AS entries
    FROM log_entries WHERE user_id = ? AND status = 'active' AND day_key >= ?
    GROUP BY display_name ORDER BY calories DESC LIMIT 10
  `).all(userId, cutoffDay(30, timezone)) as Array<{ food: string; calories: number; entries: number }>;
  const glucose = db.prepare(`
    SELECT day_key AS day, AVG(value) AS value
    FROM health_metrics WHERE user_id = ? AND metric = 'glucose' AND day_key >= ?
    GROUP BY day_key ORDER BY day_key
  `).all(userId, cutoffDay(90, timezone)) as Array<{ day: string; value: number }>;
  const monthly = db.prepare(`
    SELECT COALESCE(SUM(d.burn_total), 0) - COALESCE(SUM((
      SELECT SUM(l.calories) FROM log_entries l WHERE l.user_id=d.user_id AND l.day_key=d.day_key AND l.status='active'
    )), 0) AS deficit FROM days d WHERE d.user_id = ? AND d.day_key >= ?
  `).get(userId, cutoffDay(30, timezone)) as { deficit: number };
  return {
    weekly: weekly.map((row) => ({ ...row, net: row.intake - row.burn })),
    monthlyDeficit: monthly.deficit,
    topFoods,
    glucose
  };
}

export function getQuestionFacts(db: Database.Database, userId: string, dayKey: string, timezone: string): Record<string, unknown> {
  const today = db.prepare(`
    SELECT COALESCE(SUM(l.calories), 0) AS intake,
      (SELECT burn_total FROM days WHERE user_id = ? AND day_key = ?) AS burn
    FROM log_entries l WHERE l.user_id = ? AND l.day_key = ? AND l.status = 'active'
  `).get(userId, dayKey, userId, dayKey) as { intake: number; burn: number | null };
  const health = db.prepare(`
    SELECT metric, unit, COUNT(*) AS readings, ROUND(AVG(value), 1) AS average,
      MIN(value) AS minimum, MAX(value) AS maximum
    FROM health_metrics WHERE user_id = ? AND day_key >= ?
    GROUP BY metric, unit ORDER BY metric
  `).all(userId, cutoffDay(30, timezone)) as Array<{ metric: string; unit: string; readings: number; average: number; minimum: number; maximum: number }>;
  return { today, health };
}
