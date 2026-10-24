import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { allItems } from "./store.js";
import { mutate, userPK, profile, dayState, write, entrySchema, metricSchema, dayItems, usableBurn, InputError } from "./ledger.js";
import { resolveRequestTime } from "./time.js";
import { parseMessage, narrateFacts, type FoodImage } from "./llm.js";
import { parseBurnText } from "./parsing.js";
import { resolveCatalog } from "./resolver.js";
import { renderDailySummary, isEndOfDay } from "./renderer.js";
import { startTrends } from "./analytics.js";
import type { FoodRecord } from "./types.js";

export const chatSchema = z.object({ text: z.string().trim().min(1).max(4000), client_time: z.string().optional() }).strict();
export async function chat(store: Store, user: string, key: string, body: unknown, foods: FoodRecord[], image?: FoodImage, imageKey: string | null = null, imageHash?: string): Promise<Record<string, unknown>> {
  const input = chatSchema.parse(body);
  return mutate(store, user, key, { ...input, image_hash: imageHash ?? null }, async () => {
    const p = await profile(store, user), time = resolveRequestTime(input.client_time, p.timezone);
    const state = await dayState(store, user, time.dayKey, p);
    const oldEntries = (await allItems(store, userPK(user), { prefix: `DAY#${time.dayKey}#ENTRY#` }));
    const active = oldEntries.map((e) => ({ row: e, entry: entrySchema.parse(e.data) })).filter((e) => e.entry.status === "active");
    const parsed = await parseMessage(input.text, foods, time.original, p.timezone, image);
    const deterministicBurn = parseBurnText(input.text);
    if (deterministicBurn) { parsed.burn = deterministicBurn; parsed.intent = "burn"; }
    const yesterday = new Date(Date.parse(`${time.dayKey}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const recentFrom = new Date(Date.parse(`${time.dayKey}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    const recentItems = parsed.items.some((i) => i.match_stage === "recent_log") || parsed.intent === "question"
      ? await dayItems(store, user, recentFrom, time.dayKey) : oldEntries;
    const latest = recentItems.filter((r) => r.entity === "entry").map((r) => entrySchema.parse(r.data))
      .filter((e) => e.status === "active" && Date.parse(e.occurred_at) <= time.instant.valueOf() && (!/same as yesterday/i.test(input.text) || e.day_key === yesterday))
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
    const resolved = resolveCatalog(foods, parsed, latest?.food_id ? { foodId: latest.food_id, name: latest.display_name, calories: latest.calories, quantity: latest.quantity ?? 1, unit: latest.unit } : null);
    const needs = [...parsed.needs_clarification, ...resolved.filter((r) => r.matchStage === "unresolved").map((r) => `Could not work out calories for "${r.name}". Send it again with an amount in grams or ml (for example "30g pure peanut butter") or with your own calorie number.`)];
    const writes = [], entries = active.map((e) => e.entry);
    const recordable = resolved.filter((r) => r.matchStage !== "unresolved");
    if ((recordable.length || parsed.burn || parsed.correction) && state.data.eligibility !== "tracked")
      throw new InputError("Not tracking on this date. Explicitly enable tracking for this day before recording calories.");
    let correctionMessage: string | null = null;
    if (parsed.correction) {
      const c = parsed.correction;
      const targets = active.filter(({ entry }) => {
        const name = entry.display_name.toLocaleLowerCase(), phrase = c.target.toLocaleLowerCase();
        return name.includes(phrase) || phrase.includes(name) || entry.id === c.target;
      });
      if (targets.length !== 1) throw new InputError("Correction target is missing or ambiguous; specify the exact entry");
      const target = targets[0]!;
      let replacement = recordable[0];
      if (c.action === "replace" && recordable.length !== 1) throw new InputError("A replacement must specify exactly one food");
      if (c.action === "reduce_fraction") {
        if (c.fraction === null || c.fraction <= 0 || c.fraction >= 1) throw new InputError("Remaining fraction must be between zero and one");
        replacement = { id: randomUUID(), foodId: target.entry.food_id, raw: input.text, name: target.entry.display_name, quantity: (target.entry.quantity ?? 1) * c.fraction, unit: target.entry.unit, calories: Math.round(target.entry.calories * c.fraction), caloriesSource: target.entry.calories_source, matchStage: "correction", supersedesEntryId: target.entry.id };
      }
      const status = c.action === "void" ? "void" : "superseded";
      writes.push(write(userPK(user), target.row.SK, "entry", { ...target.entry, status, superseded_by: status === "void" ? null : replacement!.id }, target.row));
      entries.splice(entries.findIndex((e) => e.id === target.entry.id), 1);
      recordable.splice(0, recordable.length, ...(status === "void" || !replacement ? [] : [replacement]));
      correctionMessage = `${status === "void" ? "Voided" : "Updated"} ${target.entry.display_name}.`;
    } else if (recordable.some((r) => r.supersedesEntryId)) {
      throw new InputError("Use an explicit correction to replace an existing entry");
    }
    for (const r of recordable) {
      const entry = entrySchema.parse({ id: r.id, day_key: time.dayKey, occurred_at: time.original, timezone: p.timezone, food_id: r.foodId, raw_text: r.raw, display_name: r.name, quantity: r.quantity, unit: r.unit, calories: r.calories, calories_source: r.caloriesSource, match_stage: r.matchStage, status: "active", image_key: imageKey, created_at: new Date().toISOString() });
      entries.push(entry);
      writes.push(write(userPK(user), `DAY#${time.dayKey}#ENTRY#${entry.id}`, "entry", entry));
    }
    if (recordable.length || parsed.correction) state.data.completeness = "partial";
    if (parsed.burn) {
      state.data.burn_total = parsed.burn.components.length ? parsed.burn.components.reduce((a, b) => a + b, 0) : parsed.burn.total;
      state.data.burn_source = "recorded";
      state.data.burn_components = parsed.burn.components;
    }
    let answer: string | null = null;
    if (parsed.intent === "trend") {
      const job = await startTrends(store, user);
      answer = "Open Trends to view the snapshot report and its coverage.";
      return { writes: [], result: { message: answer, intent: parsed.intent, analytics: job, needs_clarification: needs } };
    }
    if (parsed.intent === "question" && parsed.question) {
      const intake = entries.reduce((n, e) => n + e.calories, 0);
      const metrics = recentItems.filter((r) => r.entity === "metric").map((r) => metricSchema.parse(r.data));
      const health = [...new Set(metrics.map((m) => m.metric))].map((metric) => {
        const group = metrics.filter((m) => m.metric === metric), values = group.map((m) => m.value);
        return { metric, unit: group[0]!.unit, readings: group.length, average: values.reduce((a, b) => a + b, 0) / values.length, minimum: Math.min(...values), maximum: Math.max(...values) };
      });
      answer = await narrateFacts(parsed.question, { today: { intake, burn: usableBurn(state.data), completeness: state.data.completeness, eligibility: state.data.eligibility }, health });
    }
    if (recordable.length || parsed.burn || parsed.correction) writes.push(write(userPK(user), `DAY#${time.dayKey}#META`, "day", state.data, state.old));
    const summary = parsed.intent === "question" ? null :
      state.data.eligibility === "untracked" ? "Not tracking today." :
      state.data.completeness === "missing" && !entries.length ? "No log for this date. No daily intake or deficit is inferred." :
      `${renderDailySummary(entries, usableBurn(state.data), time.original, state.data.timezone, isEndOfDay(time.original, state.data.timezone), active.length === 0)}\n\n${state.data.completeness === "complete" ? "Complete" : "Partial log; confirm day complete in History before calculating a daily deficit."}${state.data.burn_total !== null ? ` Burn ${state.data.burn_total} kcal (${state.data.burn_source}).` : ""}`;
    const message = [correctionMessage, needs.join(" "), answer, summary, parsed.notes].filter(Boolean).join("\n\n");
    return { writes, result: { intent: parsed.intent, items: resolved, needs_clarification: needs, correction: correctionMessage, message, summary, question: parsed.question } };
  });
}
