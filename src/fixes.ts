import { randomUUID } from "node:crypto";
import { allItems, type Store, type StoreWrite } from "./store.js";
import { dateSchema, dayState, effectiveBurn, entrySchema, usableBurn, userPK, write, InputError, type Entry, type Profile } from "./ledger.js";
import { renderDailySummary } from "./renderer.js";

// Deterministic repair commands. They never reach the LLM, so a mistake in a
// fix cannot create new food entries. The UI prints these exact lines.
export const FIX_SYNTAX = [
  "fix 10:44 PM delete",
  "fix 22:44 burn 1430 + 1550",
  "fix 10:44 PM burn",
  "fix 10:41 PM calories 150",
  "fix 2026-10-27 22:44 delete",
  "fix 11:41 AM crackers delete"
];

export type FixAction =
  | { kind: "delete" }
  | { kind: "burn"; components: number[] }
  | { kind: "calories"; calories: number };

export type FixCommand = {
  date: string | null;
  hour: number;
  minute: number;
  name: string;
  action: FixAction;
};

export type FixParse = { command: FixCommand } | { error: string } | null;

const usage = `Use: ${FIX_SYNTAX.join(" | ")}`;
const head = /^\s*fix\b/i;
const pattern = /^\s*fix\s+(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})(?:\s*(am|pm))?\s+(.*?)\s*$/i;
const action = /^(?:(.*?)\s+)?(delete|remove|void|burn(?:ed)?|calories)(?:\s+(.*))?$/i;

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function label(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")} ${period}`;
}

// Reads a fix command. Text that starts with "fix" is always a fix attempt:
// anything malformed returns an error instead of falling through to the LLM.
export function parseFixCommand(text: string): FixParse {
  if (!head.test(text)) return null;
  const match = pattern.exec(text);
  if (!match) return { error: `Could not read that fix. ${usage}` };
  const [, date, rawHour, rawMinute, period, rest] = match;
  const minute = Number(rawMinute);
  let hour = Number(rawHour);
  if (minute > 59) return { error: `Minute must be 00-59. ${usage}` };
  if (period) {
    if (hour < 1 || hour > 12) return { error: `Hour with AM/PM must be 1-12. ${usage}` };
    hour = (hour % 12) + (period.toLowerCase() === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return { error: `Hour must be 0-23 without AM/PM. ${usage}` };
  }
  if (date !== undefined && !dateSchema.safeParse(date).success) {
    return { error: `Invalid date ${date}. ${usage}` };
  }
  const parts = action.exec(rest ?? "");
  if (!parts) return { error: `Missing action (delete, burn, or calories). ${usage}` };
  const [, name = "", verb, args = ""] = parts;
  const word = verb!.toLowerCase();
  const base = { date: date ?? null, hour, minute, name: name.trim().toLowerCase() };
  if (word === "delete" || word === "remove" || word === "void") {
    if (args.trim()) return { error: `delete takes no amount. ${usage}` };
    return { command: { ...base, action: { kind: "delete" } } };
  }
  if (word.startsWith("burn")) {
    if (!args.trim()) return { command: { ...base, action: { kind: "burn", components: [] } } };
    const burn = /^(\d{2,5})(?:\s*\+\s*(\d{2,5}))?$/.exec(args.trim());
    if (!burn) return { error: `burn takes one total or two components, for example "burn 1430 + 1550". ${usage}` };
    const components = [Number(burn[1]), ...(burn[2] ? [Number(burn[2])] : [])];
    return { command: { ...base, action: { kind: "burn", components } } };
  }
  const calories = /^(\d{1,5})$/.exec(args.trim());
  if (!calories || Number(calories[1]) < 1 || Number(calories[1]) > 10000) {
    return { error: `calories takes a whole number from 1 to 10000, for example "calories 150". ${usage}` };
  }
  return { command: { ...base, action: { kind: "calories", calories: Number(calories[1]) } } };
}

// Clock time of an entry in the profile timezone, as HH:MM.
function localClock(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(instant));
}

// Applies one fix to the day it names. Matching is by clock time in the profile
// timezone; a minute shared by several entries must be narrowed by name, never guessed.
export async function applyFix(
  store: Store, user: string, command: FixCommand, p: Profile, clientDay: string
): Promise<{ writes: StoreWrite[]; result: Record<string, unknown> }> {
  const day = command.date ?? clientDay;
  const state = await dayState(store, user, day, p);
  const rows = await allItems(store, userPK(user), { prefix: `DAY#${day}#ENTRY#` });
  const found = rows.map((row) => ({ row, entry: entrySchema.parse(row.data) }));
  const active = found.filter((item) => item.entry.status === "active");
  const wanted = clock(command.hour, command.minute);
  const sameMinute = active.filter((item) => localClock(item.entry.occurred_at, p.timezone) === wanted);
  const matches = command.name
    ? sameMinute.filter((item) => `${item.entry.display_name} ${item.entry.raw_text}`.toLowerCase().includes(command.name))
    : sameMinute;
  const listing = active.map((item) => {
    const [hour, minute] = localClock(item.entry.occurred_at, p.timezone).split(":").map(Number) as [number, number];
    return `${label(hour, minute)} ${item.entry.display_name} (${Math.round(item.entry.calories)} kcal)`;
  }).join("; ");
  const shown = label(command.hour, command.minute);
  if (matches.length === 0) {
    throw new InputError(`No active entry at ${shown} on ${day}.${listing ? ` Active entries that day: ${listing}.` : " No active entries that day."}`);
  }
  if (matches.length > 1) {
    const word = matches[0]!.entry.display_name.split(" ")[0]!.toLowerCase();
    const verb = command.action.kind === "calories" ? `calories ${command.action.calories}` : command.action.kind;
    throw new InputError(`${matches.length} active entries at ${shown} on ${day}: ${matches.map((m) => m.entry.display_name).join("; ")}. Add a name, for example: fix ${shown} ${word} ${verb}`);
  }
  const target = matches[0]!;
  const entry: Entry = target.entry;
  const writes: StoreWrite[] = [];
  const remaining = active.filter((item) => item !== target).map((item) => item.entry);
  let message: string;
  let resultFix: Record<string, unknown>;

  if (command.action.kind === "delete") {
    writes.push(write(userPK(user), target.row.SK, "entry", { ...target.row.data, status: "void", superseded_by: null }, target.row));
    message = `Deleted ${shown} entry "${entry.display_name}" (${Math.round(entry.calories)} kcal).`;
    resultFix = { action: "delete", voided_entry_id: entry.id };
  } else if (command.action.kind === "burn") {
    if (state.data.eligibility !== "tracked") {
      throw new InputError("Not tracking on this date. Set the day to tracked in History before recording burn.");
    }
    const components = command.action.components;
    const total = components.length ? components.reduce((sum, value) => sum + value, 0) : entry.calories;
    writes.push(write(userPK(user), target.row.SK, "entry", { ...target.row.data, status: "void", superseded_by: null }, target.row));
    state.data.burn_total = total;
    state.data.burn_source = "recorded";
    state.data.burn_components = components;
    writes.push(write(userPK(user), `DAY#${day}#META`, "day", state.data, state.old));
    message = `Moved ${shown} entry "${entry.display_name}" (${Math.round(entry.calories)} kcal) to burn: ${total} kcal recorded${components.length ? ` (${components.join(" + ")})` : ""}.`;
    resultFix = { action: "burn", voided_entry_id: entry.id, burn_total: total, burn_components: components };
  } else {
    const calories = command.action.calories;
    const id = randomUUID();
    const replacement = entrySchema.parse({
      id, day_key: day, occurred_at: entry.occurred_at, timezone: entry.timezone, food_id: null,
      raw_text: `fix ${shown} calories ${calories}`, display_name: entry.display_name,
      quantity: entry.quantity, unit: entry.unit, calories, calories_source: "user_number",
      match_stage: "correction", status: "active", superseded_by: null, image_key: entry.image_key,
      created_at: new Date().toISOString()
    });
    writes.push(write(userPK(user), target.row.SK, "entry", { ...target.row.data, status: "superseded", superseded_by: id }, target.row));
    writes.push(write(userPK(user), `DAY#${day}#ENTRY#${id}`, "entry", replacement));
    remaining.push(replacement);
    message = `Corrected ${shown} entry "${entry.display_name}" from ${Math.round(entry.calories)} to ${calories} kcal.`;
    resultFix = { action: "calories", superseded_entry_id: entry.id, entry_id: id, calories };
  }

  const effective = effectiveBurn(state.data);
  const summary = renderDailySummary(remaining, effective?.total ?? null, entry.occurred_at, state.data.timezone, false, true, effective?.source);
  const note = usableBurn(state.data) === null ? "Net is unknown until the day is complete." : "";
  return {
    writes,
    result: {
      intent: "fix", items: [], needs_clarification: [], fix: { day, ...resultFix },
      message: [message, summary, note].filter(Boolean).join("\n\n"), summary
    }
  };
}
