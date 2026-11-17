import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, StoreWrite } from "./store.js";
import { allItems } from "./store.js";
import { mutate, userPK, profile, dayState, write, dateSchema, entrySchema, metricSchema, dayItems, usableBurn, effectiveBurn, effectiveCompleteness, InputError, type Entry } from "./ledger.js";
import { clockTime, instantAt, resolveRequestTime, type RequestTime } from "./time.js";
import { parseWeightText, type WeightMessage } from "./weight.js";
import { parseMessage, narrateFacts, type FoodImage } from "./llm.js";
import { burnDayPhrases, parseBurnText } from "./parsing.js";
import { resolveCatalog, type ResolvedItem } from "./resolver.js";
import { normalizeFoodText } from "./seed.js";
import { renderDailySummary, isEndOfDay } from "./renderer.js";
import { startTrends } from "./analytics.js";
import { applyFix, parseFixCommand } from "./fixes.js";
import { questionFacts } from "./analysis.js";
import type { FoodRecord } from "./types.js";

export const chatSchema = z.object({ text: z.string().trim().min(1).max(4000), client_time: z.string().optional() }).strict();

// Burn text is never food. A model that echoes "burned 1430 + 1550" as a 2,980 kcal
// item is what put burn into intake, so such items are dropped before any write.
export function looksLikeBurn(item: { raw: string; display_name: string }): boolean {
  const text = `${item.raw} ${item.display_name}`;
  return /\bburn(?:ed)?\b/i.test(text) || /\d{3,5}\s*\+\s*\d{3,5}/.test(text);
}

// Corrections can reach back this many days. The target must be an active entry in that window.
export const CORRECTION_WINDOW_DAYS = 7;

function clockOf(entry: Entry): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: entry.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(entry.occurred_at));
}

// The entries a correction could have meant, so the user can name one exactly.
function entryChoices(rows: Array<{ entry: Entry }>): string {
  if (!rows.length) return "none";
  return rows.map(({ entry }) => `${entry.display_name} (${entry.day_key} ${clockOf(entry)}, ${Math.round(entry.calories)} kcal)`).join("; ");
}

// A catalog food named in the message that no parsed item covers is probably merged into another item or dropped.
// Matching is by whole word, allows a plural ("cheeses"), and ignores punctuation ("cheese,").
// An item covers only the food it resolved to (its key or its name), never every food its raw text mentions:
// "cheese and bread" resolved to Cheese does not cover Bread.
export function possiblyMissingFoods(text: string, items: Array<{ raw: string; display_name: string; food_key: string | null }>, foods: FoodRecord[]): string[] {
  const clean = (value: string) => ` ${normalizeFoodText(value.replace(/[^\p{L}\p{N}]+/gu, " "))} `;
  const said = clean(text);
  const covered = items.map((i) => clean(i.display_name));
  const word = (name: string) => new RegExp(` ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)? `);
  return foods.filter((food) => {
    const names = [food.name, ...food.aliases].map((n) => normalizeFoodText(n.replace(/[^\p{L}\p{N}]+/gu, " "))).filter((n) => n.length >= 3);
    if (!names.some((n) => word(n).test(said))) return false;
    return !(items.some((i) => i.food_key === food.id) || names.some((n) => covered.some((c) => word(n).test(c))));
  }).map((food) => food.name);
}

// A posted weight is one metric row on the day it was posted. The time is the one the user gave, or the request's time.
// A refusal writes nothing and says what to send instead.
function weightReply(weight: WeightMessage, user: string, time: RequestTime, timezone: string): { writes: StoreWrite[]; result: Record<string, unknown> } {
  const reply = (message: string) => ({
    intent: "weight", items: [], unclear: [], needs_clarification: [], correction: null, message, summary: null, question: null
  });
  if (weight.kind === "refuse") return { writes: [], result: reply(weight.message) };
  const instant = weight.time ? instantAt(time.dayKey, weight.time.hour, weight.time.minute, timezone) : time.instant;
  const id = randomUUID();
  const data = metricSchema.parse({
    id, day_key: time.dayKey, occurred_at: instant.toISOString(), timezone,
    metric: "weight", value: weight.value, unit: "kg", source: "user_input"
  });
  return {
    writes: [write(userPK(user), `DAY#${time.dayKey}#METRIC#${id}`, "metric", data)],
    result: reply(`Recorded weight ${weight.value} kg on ${time.dayKey} at ${clockTime(instant, timezone)} (${timezone}).`)
  };
}

export async function chat(store: Store, user: string, key: string, body: unknown, foods: FoodRecord[], image?: FoodImage, imageKey: string | null = null, imageHash?: string): Promise<Record<string, unknown>> {
  const input = chatSchema.parse(body);
  const fix = parseFixCommand(input.text);
  if (fix) {
    // Fix commands are deterministic: no LLM call, and a bad command is refused.
    return mutate(store, user, key, { ...input, image_hash: imageHash ?? null }, async () => {
      if ("error" in fix) throw new InputError(fix.error);
      const p = await profile(store, user), time = resolveRequestTime(input.client_time, p.timezone);
      return applyFix(store, user, fix.command, p, time.dayKey);
    });
  }
  return mutate(store, user, key, { ...input, image_hash: imageHash ?? null }, async () => {
    const p = await profile(store, user), time = resolveRequestTime(input.client_time, p.timezone);
    // A weight is recorded only when the user posts one. It never reaches the model, and it is never a food entry.
    const weight = parseWeightText(input.text);
    if (weight) return weightReply(weight, user, time, p.timezone);
    const state = await dayState(store, user, time.dayKey, p);
    const oldEntries = (await allItems(store, userPK(user), { prefix: `DAY#${time.dayKey}#ENTRY#` }));
    const active = oldEntries.map((e) => ({ row: e, entry: entrySchema.parse(e.data) })).filter((e) => e.entry.status === "active");
    // Corrections can target any active entry in the window, not only today's. `active` stays today's tally.
    const correctionFrom = new Date(Date.parse(`${time.dayKey}T12:00:00Z`) - (CORRECTION_WINDOW_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const correctable = (await dayItems(store, user, correctionFrom, time.dayKey)).filter((r) => r.entity === "entry")
      .map((r) => ({ row: r, entry: entrySchema.parse(r.data) })).filter((e) => e.entry.status === "active");
    const parsed = await parseMessage(input.text, foods, time.original, p.timezone, image);
    const yesterday = new Date(Date.parse(`${time.dayKey}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const deterministicBurn = parseBurnText(input.text);
    if (deterministicBurn) { parsed.burn = deterministicBurn; parsed.intent = "burn"; }
    // A question only reads the ledger. It returns here, before any write is prepared or any guard runs,
    // even if the model also returned items, a burn, or a correction.
    if (parsed.intent === "question" && parsed.question) {
      const todayEntries = active.map((e) => e.entry);
      const todayCompleteness = effectiveCompleteness(state.data, todayEntries.length, time.dayKey);
      const intake = todayEntries.reduce((n, e) => n + e.calories, 0);
      const facts = await questionFacts(store, user, p, time.dayKey, parsed.question);
      const answer = await narrateFacts(parsed.question, { today: { intake, burn: usableBurn(state.data, todayCompleteness), completeness: todayCompleteness, eligibility: state.data.eligibility }, ...facts });
      return { writes: [], result: { intent: parsed.intent, items: [], unclear: [], needs_clarification: [], correction: null, message: answer, summary: null, question: parsed.question } };
    }
    // The day comes from the burn's own clause, so it applies to a model-read burn too.
    // Without a named day the burn belongs to the request's day.
    const phrases = parsed.burn ? burnDayPhrases(input.text) : [];
    if (phrases.length > 1) throw new InputError("This message names more than one day for a burn. Send one burn per day.");
    const phrase = phrases[0] ?? "today";
    let burnDayKey = time.dayKey;
    if (phrase === "yesterday") burnDayKey = yesterday;
    else if (/^\d{2}-\d{2}$/.test(phrase)) {
      // Month and day only: same year as the request, or the previous year if that date is still ahead.
      const year = Number(time.dayKey.slice(0, 4));
      const candidate = `${year}-${phrase}`;
      burnDayKey = candidate > time.dayKey ? `${year - 1}-${phrase}` : candidate;
    } else if (phrase !== "today") {
      burnDayKey = phrase;
    }
    if (!dateSchema.safeParse(burnDayKey).success) throw new InputError(`Invalid burn date ${phrase}. Use "Nov 1", YYYY-MM-DD, or "yesterday".`);
    const burnElsewhere = Boolean(parsed.burn) && burnDayKey !== time.dayKey;
    const burnState = burnElsewhere ? await dayState(store, user, burnDayKey, p) : state;
    const burnItems = parsed.items.filter(looksLikeBurn);
    parsed.items = parsed.items.filter((item) => !looksLikeBurn(item));
    const burnNote = burnItems.length
      ? `Not logged as food: ${burnItems.map((item) => `"${item.raw}"`).join(", ")}.${deterministicBurn ? "" : " Burn is recorded from its total; repair a wrong entry with \"fix <time> delete\"."}`
      : "";
    const recentFrom = new Date(Date.parse(`${time.dayKey}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    const recentItems = parsed.items.some((i) => i.match_stage === "recent_log")
      ? await dayItems(store, user, recentFrom, time.dayKey) : oldEntries;
    const latest = recentItems.filter((r) => r.entity === "entry").map((r) => entrySchema.parse(r.data))
      .filter((e) => e.status === "active" && Date.parse(e.occurred_at) <= time.instant.valueOf() && (!/same as yesterday/i.test(input.text) || e.day_key === yesterday))
      .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
    const resolved = resolveCatalog(foods, parsed, latest?.food_id ? { foodId: latest.food_id, name: latest.display_name, calories: latest.calories, quantity: latest.quantity ?? 1, unit: latest.unit } : null);
    // Nothing is held back for a clarification: every item is recorded, and anything unsure is listed in `unclear`.
    const unclear: string[] = [...parsed.needs_clarification];
    for (const r of resolved) {
      if (r.matchStage === "unresolved") unclear.push(`"${r.name}" was recorded at 0 kcal: no calories were found. Fix it with "fix <time> calories <kcal>".`);
      else if (r.matchStage === "ambiguous" && r.calorieRange) unclear.push(`"${r.name}" matches catalog options from ${r.calorieRange.low} to ${r.calorieRange.high} kcal. Recorded ${r.calories} kcal. If that is wrong, use "fix <time> calories <kcal>".`);
    }
    for (const name of possiblyMissingFoods(input.text, parsed.items, foods)) {
      unclear.push(`"${name}" is named in your message but no entry covers it. If you ate it, send it as its own message or fix the entries.`);
    }
    const writes = [], entries = active.map((e) => e.entry);
    const recordable = resolved;
    // Only new food placed today needs today to be tracked. A correction is checked against the day it changes.
    if (recordable.length && state.data.eligibility !== "tracked")
      throw new InputError("Not tracking on this date. Explicitly enable tracking for this day before recording calories.");
    if (parsed.burn && burnState.data.eligibility !== "tracked")
      throw new InputError(`Not tracking on ${burnDayKey}. Set that day to tracked in History before recording burn.`);
    let correctionMessage: string | null = null;
    // A correction's replacement keeps the original entry's day and time, so that day's tally is restated in place.
    // Other items in the same message (a split: "half yesterday, the other half now") are new entries today.
    const placed: Array<{ item: ResolvedItem; day_key: string; occurred_at: string; timezone: string }> = [];
    const newItems = [...recordable];
    let correctedDay: string | null = null;
    let correctedName: string | null = null;
    if (parsed.correction) {
      const c = parsed.correction;
      const phrase = c.target.toLocaleLowerCase();
      const targets = correctable.filter(({ entry }) => {
        const name = entry.display_name.toLocaleLowerCase();
        return name.includes(phrase) || phrase.includes(name) || entry.id === c.target;
      });
      if (targets.length !== 1) {
        const found = targets.length ? `${targets.length} entries match "${c.target}"` : `No entry matches "${c.target}"`;
        throw new InputError(`${found}. Name the exact entry. Active entries from the last ${CORRECTION_WINDOW_DAYS} days: ${entryChoices(targets.length ? targets : correctable)}.`);
      }
      const target = targets[0]!;
      if (c.action === "replace" && recordable.length !== 1) throw new InputError("A replacement must specify exactly one food");
      let replacement: ResolvedItem | null = null;
      if (c.action === "replace") {
        replacement = recordable[0]!;
        newItems.length = 0;
      }
      if (c.action === "reduce_fraction") {
        if (c.fraction === null || c.fraction <= 0 || c.fraction >= 1) throw new InputError("Remaining fraction must be between zero and one");
        replacement = { id: randomUUID(), foodId: target.entry.food_id, raw: input.text, name: target.entry.display_name, quantity: (target.entry.quantity ?? 1) * c.fraction, unit: target.entry.unit, calories: Math.round(target.entry.calories * c.fraction), caloriesSource: target.entry.calories_source, matchStage: "correction", supersedesEntryId: target.entry.id };
      }
      // A replacement lands on the corrected entry's own day, so that day must be tracked.
      if (replacement && (await dayState(store, user, target.entry.day_key, p)).data.eligibility !== "tracked")
        throw new InputError(`Not tracking on ${target.entry.day_key}. Set that day to tracked in History before correcting it.`);
      const status = c.action === "void" ? "void" : "superseded";
      writes.push(write(userPK(user), target.row.SK, "entry", { ...target.entry, status, superseded_by: status === "void" ? null : replacement?.id ?? null }, target.row));
      const index = entries.findIndex((e) => e.id === target.entry.id);
      if (index >= 0) entries.splice(index, 1);
      if (status !== "void" && replacement) placed.push({ item: replacement, day_key: target.entry.day_key, occurred_at: target.entry.occurred_at, timezone: target.entry.timezone });
      correctedDay = target.entry.day_key;
      correctedName = target.entry.display_name;
      correctionMessage = `${status === "void" ? "Voided" : "Updated"} ${target.entry.display_name}${target.entry.day_key === time.dayKey ? "" : ` on ${target.entry.day_key}`}.`;
    } else if (recordable.some((r) => r.supersedesEntryId)) {
      throw new InputError("Use an explicit correction to replace an existing entry");
    }
    // A correction that also names a new item is either a split ("the other half now") or a repeat of the same portion.
    // The app cannot tell which from the text, so it records the item and says so.
    if (parsed.correction?.action === "reduce_fraction" && correctedName) {
      for (const r of newItems) unclear.push(`"${r.name}" was recorded as a new entry today. If it repeats the portion you corrected, remove it with "fix <time> delete".`);
    }
    for (const item of newItems) placed.push({ item, day_key: time.dayKey, occurred_at: time.original, timezone: p.timezone });
    for (const { item: r, day_key, occurred_at, timezone } of placed) {
      const entry = entrySchema.parse({ id: r.id, day_key, occurred_at, timezone, food_id: r.foodId, raw_text: r.raw, display_name: r.name, quantity: r.quantity, unit: r.unit, calories: r.calories, calories_source: r.caloriesSource, match_stage: r.matchStage, status: "active", image_key: imageKey, created_at: new Date().toISOString() });
      if (day_key === time.dayKey) entries.push(entry);
      writes.push(write(userPK(user), `DAY#${day_key}#ENTRY#${entry.id}`, "entry", entry));
    }
    // Automatic completeness follows the entries, so logging needs no flag. A day the user had confirmed as complete
    // reopens to automatic when its entries change. A day flagged incomplete stays flagged.
    // Only a change to today's entries reopens today. A correction to an earlier day reopens that day only.
    if ((recordable.length || correctedDay === time.dayKey) && state.data.completeness === "complete") state.data.completeness = "missing";
    if (correctedDay && correctedDay !== time.dayKey) {
      // When the burn is recorded on the same day, that day's record is already being written: reuse it,
      // so the request never writes the same item twice.
      const sameAsBurn = burnElsewhere && correctedDay === burnDayKey;
      const corrected = sameAsBurn ? burnState : await dayState(store, user, correctedDay, p);
      if (corrected.data.completeness === "complete") {
        corrected.data.completeness = "missing";
        if (!sameAsBurn) writes.push(write(userPK(user), `DAY#${correctedDay}#META`, "day", corrected.data, corrected.old));
      }
    }
    const burnTotal = parsed.burn ? (parsed.burn.components.length ? parsed.burn.components.reduce((a, b) => a + b, 0) : parsed.burn.total) : null;
    if (parsed.burn) {
      burnState.data.burn_total = burnTotal;
      burnState.data.burn_source = "recorded";
      burnState.data.burn_components = parsed.burn.components;
    }
    let answer: string | null = null;
    if (parsed.intent === "trend") {
      const job = await startTrends(store, user);
      answer = "Open Trends to view the snapshot report and its coverage.";
      return { writes: [], result: { message: answer, intent: parsed.intent, analytics: job, needs_clarification: unclear, unclear } };
    }
    // Today's completeness as the app shows it: automatic from its entries, unless the user flagged or confirmed it.
    const todayCompleteness = effectiveCompleteness(state.data, entries.length, time.dayKey);
    if (recordable.length || (parsed.burn && !burnElsewhere) || parsed.correction) writes.push(write(userPK(user), `DAY#${time.dayKey}#META`, "day", state.data, state.old));
    if (burnElsewhere) writes.push(write(userPK(user), `DAY#${burnDayKey}#META`, "day", burnState.data, burnState.old));
    const burnLine = burnElsewhere ? `Burn recorded for ${burnDayKey}: ${burnTotal} kcal${parsed.burn!.components.length ? ` (${parsed.burn!.components.join(" + ")})` : ""}. It replaces any earlier burn for that day.` : "";
    const summary = parsed.intent === "question" ? null :
      burnElsewhere && !recordable.length && !parsed.correction ? null :
      state.data.eligibility === "untracked" ? "Not tracking today." :
      todayCompleteness === "missing" && !entries.length ? "No log for this date. No daily intake or deficit is inferred." :
      `${renderDailySummary(entries, effectiveBurn(state.data)?.total ?? null, time.original, state.data.timezone, isEndOfDay(time.original, state.data.timezone), active.length === 0, effectiveBurn(state.data)?.source)}\n\n${todayCompleteness === "complete" ? "Complete" : state.data.completeness === "partial" ? "Flagged incomplete: this total is not a whole-day figure." : "Partial log: it completes automatically when the day ends. Flag it incomplete in History if surprises took over."}`;
    const message = [correctionMessage, answer, summary, burnLine, burnNote, parsed.notes].filter(Boolean).join("\n\n");
    return { writes, result: { intent: parsed.intent, items: resolved, needs_clarification: unclear, unclear, correction: correctionMessage, message, summary, question: parsed.question } };
  });
}
