import { createHash } from "node:crypto";
import { z } from "zod";
import { allItems, StoreConflict, type Store, type StoreItem, type StoreWrite } from "./store.js";
import { assertTimezone, dayKeyFor } from "./time.js";

export class InputError extends Error {}
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
export const profileSchema = z.object({
  timezone: z.string().default("Asia/Jerusalem").refine((zone) => {
    try { assertTimezone(zone); return true; } catch { return false; }
  }, "Invalid timezone"),
  holidays: z.array(dateSchema).max(1000).default([]),
  non_tracking_weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([5, 6])
});
export const profileUpdateSchema = z.object({
  timezone: profileSchema.shape.timezone.removeDefault().optional(),
  holidays: profileSchema.shape.holidays.removeDefault().optional(),
  non_tracking_weekdays: profileSchema.shape.non_tracking_weekdays.removeDefault().optional()
}).strict();
export const daySchema = z.object({
  day_key: dateSchema, timezone: z.string(),
  eligibility: z.enum(["tracked", "untracked"]),
  completeness: z.enum(["missing", "partial", "complete"]),
  burn_total: z.number().nonnegative().nullable().default(null),
  burn_source: z.enum(["recorded", "assumed"]).nullable().default(null),
  accept_default_burn: z.boolean().default(false),
  burn_components: z.array(z.number()).default([])
});
export const dayUpdateSchema = z.object({
  eligibility: daySchema.shape.eligibility.optional(),
  completeness: daySchema.shape.completeness.optional(),
  accept_default_burn: z.boolean().optional()
}).strict();
export const entrySchema = z.object({
  id: z.string(), day_key: dateSchema, occurred_at: z.string(), timezone: z.string(),
  food_id: z.string().nullable().default(null), raw_text: z.string().default(""),
  display_name: z.string().min(1).max(500), quantity: z.number().nullable().default(null),
  unit: z.string().default("portion"), calories: z.number().finite().nonnegative().max(100000),
  calories_source: z.enum(["db", "user_number", "estimate"]),
  match_stage: z.string(), status: z.enum(["active", "superseded", "void"]),
  superseded_by: z.string().nullable().default(null), image_key: z.string().nullable().default(null),
  source_id: z.string().optional(), created_at: z.string()
});
export const metricSchema = z.object({
  id: z.string(), day_key: dateSchema, occurred_at: z.string(), timezone: z.string(),
  metric: z.enum(["glucose", "bp_systolic", "bp_diastolic", "weight"]),
  value: z.number().finite(), unit: z.string(), source: z.string()
}).superRefine((m, ctx) => {
  const ranges = { glucose: [20, 600, "mg/dL"], bp_systolic: [50, 300, "mmHg"], bp_diastolic: [30, 200, "mmHg"], weight: [20, 500, "kg"] } as const;
  const [min, max, unit] = ranges[m.metric];
  if (m.value < min || m.value > max || m.unit !== unit) ctx.addIssue({ code: "custom", message: "Invalid metric value/unit" });
});
export type Profile = z.infer<typeof profileSchema>;
export type Day = z.infer<typeof daySchema>;
export type Entry = z.infer<typeof entrySchema>;
export const userPK = (user: string): string => `USER#${user}`;
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export function write(PK: string, SK: string, entity: string, data: Record<string, unknown>, previous?: StoreItem): StoreWrite {
  return { item: { PK, SK, entity, data, version: (previous?.version ?? 0) + 1 }, expectedVersion: previous?.version ?? null };
}
export async function profile(store: Store, user: string): Promise<Profile> {
  const old = await store.get(userPK(user), "PROFILE");
  if (old) return profileSchema.parse(old.data);
  const data = profileSchema.parse({});
  try { await store.transact([write(userPK(user), "PROFILE", "profile", data)]); }
  catch (error) { if (!(error instanceof StoreConflict)) throw error; }
  const saved = await store.get(userPK(user), "PROFILE");
  if (!saved) throw new Error("Profile could not be created");
  return profileSchema.parse(saved.data);
}
export function eligible(day: string, p: Profile): boolean {
  return !p.holidays.includes(day) && !p.non_tracking_weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay());
}
export function newDay(day: string, p: Profile): Day {
  return { day_key: day, timezone: p.timezone, eligibility: eligible(day, p) ? "tracked" : "untracked", completeness: "missing", burn_total: null, burn_source: null, accept_default_burn: false, burn_components: [] };
}
export async function dayState(store: Store, user: string, day: string, p: Profile): Promise<{ old?: StoreItem; data: Day }> {
  const old = await store.get(userPK(user), `DAY#${day}#META`);
  return { ...(old ? { old } : {}), data: old ? daySchema.parse(old.data) : newDay(day, p) };
}
// Tracked days without a written burn assume this default (labelled "assumed").
export const defaultBurn = 2000;
export function effectiveBurn(d: Day): { total: number; source: "recorded" | "assumed" } | null {
  if (d.eligibility !== "tracked") return null;
  if (d.burn_total !== null) return { total: d.burn_total, source: d.burn_source === "recorded" ? "recorded" : "assumed" };
  return { total: defaultBurn, source: "assumed" };
}
// Net is only computed for complete tracked days; it uses the effective burn.
export function usableBurn(d: Day): number | null {
  const burn = effectiveBurn(d);
  return burn && d.completeness === "complete" ? burn.total : null;
}
export function dateRange(from?: string, to?: string): { from: string; to: string } {
  const start = dateSchema.parse(from ?? "1900-01-01");
  const end = dateSchema.parse(to ?? "2200-12-31");
  if (start > end) throw new InputError("Start date must not follow end date");
  return { from: start, to: end };
}
export async function dayItems(store: Store, user: string, from: string, to: string): Promise<StoreItem[]> {
  return allItems(store, userPK(user), { from: `DAY#${from}#`, to: `DAY#${to}#\uffff` });
}
export async function history(store: Store, user: string, from?: string, to?: string) {
  const p = await profile(store, user);
  const today = dayKeyFor(new Date(), p.timezone);
  const end = dateSchema.parse(to ?? today);
  const start = from ?? new Date(new Date(`${end}T12:00:00Z`).valueOf() - 29 * 86400000).toISOString().slice(0, 10);
  dateRange(start, end);
  const count = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (count > 3660) throw new InputError("Load at most ten years of daily history at once");
  const items = await dayItems(store, user, start, end);
  const days = new Map(items.filter((i) => i.entity === "day").map((i) => [daySchema.parse(i.data).day_key, daySchema.parse(i.data)]));
  const entries = items.filter((i) => i.entity === "entry").map((i) => entrySchema.parse(i.data)).filter((e) => e.status === "active");
  return Array.from({ length: count }, (_, offset) => {
    const day = new Date(Date.parse(`${end}T12:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
    const d = days.get(day) ?? newDay(day, p);
    const rows = entries.filter((e) => e.day_key === day).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const burn = usableBurn(d);
    const effective = effectiveBurn(d);
    return { day, timezone: d.timezone, burn: effective?.total ?? null, burn_source: effective?.source ?? null, eligibility: d.eligibility, completeness: d.completeness, entries: rows, net: burn === null ? null : rows.reduce((n, e) => n + e.calories, 0) - burn };
  });
}
export async function replay(store: Store, user: string, key: string, payload: unknown): Promise<Record<string, unknown> | undefined> {
  const old = await store.get(userPK(user), `REQUEST#${key}`);
  if (!old) return undefined;
  if (old.data.hash !== digest(payload)) throw new StoreConflict("Idempotency key was already used for different input");
  return z.record(z.string(), z.unknown()).parse(old.data.result);
}
export async function mutate(store: Store, user: string, key: string, payload: unknown, build: () => Promise<{ writes: StoreWrite[]; result: Record<string, unknown> }>): Promise<Record<string, unknown>> {
  const previous = await replay(store, user, key, payload);
  if (previous) return previous;
  const { writes, result } = await build();
  try {
    await store.transact([...writes, write(userPK(user), `REQUEST#${key}`, "receipt", { hash: digest(payload), result })]);
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    const saved = await replay(store, user, key, payload);
    if (saved) return saved;
    throw error;
  }
  return result;
}
