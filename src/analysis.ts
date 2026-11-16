import type { Store } from "./store.js";
import { dayItems, daySchema, effectiveBurn, effectiveCompleteness, entrySchema, metricSchema, newDay, type Profile } from "./ledger.js";

// Health questions read at most this many days of daily records, so the prompt stays bounded.
export const maxAnalysisDays = 92;

const addDays = (day: string, amount: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);

export type AnalysisWindow = { from: string; to: string; label: string };

// The period a health question is about, from phrases in the question. Default: the last 31 days, ending today.
export function analysisWindow(question: string, today: string): AnalysisWindow {
  const text = question.toLowerCase();
  const [year, month] = today.split("-").map(Number) as [number, number];
  if (/\blast month\b/.test(text)) {
    return {
      from: new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10),
      to: new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10),
      label: "last month"
    };
  }
  if (/\bthis month\b/.test(text)) return { from: `${today.slice(0, 8)}01`, to: today, label: "this month" };
  if (/\blast week\b/.test(text)) return { from: addDays(today, -6), to: today, label: "last 7 days" };
  const span = /\blast (\d{1,3}) days\b/.exec(text);
  if (span) {
    const n = Math.min(Math.max(Number(span[1]), 1), maxAnalysisDays);
    return { from: addDays(today, 1 - n), to: today, label: `last ${n} days` };
  }
  return { from: addDays(today, -30), to: today, label: "last 31 days" };
}

// Pre-computed facts for a health question: one row per calendar day in the window, plus health readings.
// Completeness is the effective value (the same rule the History page and analytics use).
export async function questionFacts(store: Store, user: string, p: Profile, today: string, question: string) {
  const window = analysisWindow(question, today);
  const items = await dayItems(store, user, window.from, window.to);
  const days = new Map(items.filter((i) => i.entity === "day").map((i) => {
    const d = daySchema.parse(i.data);
    return [d.day_key, d] as const;
  }));
  const entries = items.filter((i) => i.entity === "entry").map((i) => entrySchema.parse(i.data)).filter((e) => e.status === "active");
  const metrics = items.filter((i) => i.entity === "metric").map((i) => metricSchema.parse(i.data));
  const count = Math.round((Date.parse(window.to) - Date.parse(window.from)) / 86400000) + 1;
  const rows = Array.from({ length: count }, (_, offset) => {
    const date = addDays(window.from, offset);
    const d = days.get(date) ?? newDay(date, p);
    const dayEntries = entries.filter((e) => e.day_key === date);
    const completeness = effectiveCompleteness(d, dayEntries.length, today);
    const intake = dayEntries.reduce((n, e) => n + e.calories, 0);
    const burn = effectiveBurn(d);
    return {
      date,
      tracking: d.eligibility,
      completeness,
      intake: completeness === "missing" ? null : Math.round(intake),
      entries: dayEntries.length,
      burn: burn?.total ?? null,
      burn_source: burn?.source ?? null,
      net: d.eligibility === "tracked" && completeness === "complete" && burn ? Math.round(intake - burn.total) : null
    };
  });
  const health = [...new Set(metrics.map((m) => m.metric))].map((metric) => {
    // Chronological, so the direction of change is visible: first and last reading, and last minus first.
    const group = metrics.filter((m) => m.metric === metric).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const values = group.map((m) => m.value);
    const first = group[0]!, last = group[group.length - 1]!;
    return {
      metric, unit: first.unit, readings: group.length,
      average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
      minimum: Math.min(...values), maximum: Math.max(...values),
      first: { at: first.occurred_at, value: first.value },
      last: { at: last.occurred_at, value: last.value },
      change: Math.round((last.value - first.value) * 10) / 10
    };
  });
  return {
    window: { label: window.label, from: window.from, to: window.to, days: count },
    days: rows,
    health,
    how_to_read: [
      "completeness missing: no log that day. Its intake is null. Do not treat it as zero.",
      "completeness partial: the day is today or was flagged incomplete. Its intake is not a whole-day total.",
      "completeness complete: intake is the whole-day total. net = intake minus burn, only for complete tracked days.",
      "untracked days are excluded from averages of deficit."
    ]
  };
}
