import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, StoreConflict } from "../src/store.js";
import { profile, userPK, write, mutate, history, dayState, eligible, profileSchema, digest } from "../src/ledger.js";
import { previewImport, reviewImport, confirmImport, importReport } from "../src/imports.js";
import { analyticsSQL, localTrends } from "../src/analytics.js";
import { chat } from "../src/chat.js";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("../src/llm.js", () => ({ parseMessage: parse, narrateFacts: vi.fn().mockResolvedValue("Known facts only") }));
let store: SQLiteStore;
beforeEach(() => { store = new SQLiteStore(createDatabase(":memory:")); });
afterEach(() => { store.close(); vi.useRealTimers(); });
const meal = (id: string, timestamp = "2025-01-05T12:00:00+02:00", calories = 100) => ({
  id, timestamp, timezone: "Asia/Jerusalem", kind: "meal", display_name: "Eggs", calories
});
async function finish(id: string) {
  let report = await confirmImport(store, "u", id);
  for (let n = 0; n < 300 && report.status === "running"; n++) report = await confirmImport(store, "u", id);
  return report;
}
describe("ledger policies and idempotency", () => {
  it("does not fabricate burn/deficit for empty or excluded days and returns 30 calendar days", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const days = await history(store, "u");
    expect(days).toHaveLength(30);
    expect(days[0]?.day).toBe("2026-10-25");
    expect(days[29]?.day).toBe("2026-09-26");
    expect(days.every((d) => d.net === null && d.burn === null && d.completeness === "missing")).toBe(true);
    expect(days.find((d) => d.day === "2026-10-23")?.eligibility).toBe("untracked");
    expect(eligible("2026-10-25", profileSchema.parse({ holidays: ["2026-10-25"] }))).toBe(false);
  });
  it("stores a durable result and rejects same-key different-payload and atomic races", async () => {
    const operation = vi.fn(async () => ({ writes: [write(userPK("u"), "THING", "test", { count: 1 })], result: { id: 1 } }));
    expect(await mutate(store, "u", "key", { n: 1 }, operation)).toEqual({ id: 1 });
    expect(await mutate(store, "u", "key", { n: 1 }, operation)).toEqual({ id: 1 });
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(mutate(store, "u", "key", { n: 2 }, operation)).rejects.toBeInstanceOf(StoreConflict);
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });
  it("does not rewrite stored timezone or eligibility after profile edits", async () => {
    const p = await profile(store, "u");
    const state = await dayState(store, "u", "2025-01-05", p);
    await store.transact([write(userPK("u"), "DAY#2025-01-05#META", "day", state.data)]);
    const old = await store.get(userPK("u"), "PROFILE");
    await store.transact([write(userPK("u"), "PROFILE", "profile", { ...p, timezone: "America/Los_Angeles", holidays: ["2025-01-05"] }, old)]);
    const days = await history(store, "u", "2025-01-05", "2025-01-05");
    expect(days[0]).toMatchObject({ timezone: "Asia/Jerusalem", eligibility: "tracked" });
  });
  it("logs each chat once and appends an atomic correction without replacing history", async () => {
    const empty = { intent: "food_log", day_hint: null, burn: null, correction: null, question: null, needs_clarification: [], notes: "" };
    parse.mockResolvedValue({ ...empty, items: [{ raw: "eggs 150 calories", display_name: "Eggs", quantity: 2, unit: "unit", calories: 150, food_key: null, match_stage: "user_number", calories_source: "user_number", supersedes_entry_id: null }] });
    const body = { text: "eggs 150 calories", client_time: "2025-01-05T12:00:00+02:00" };
    await chat(store, "u", "chat-one", body, []);
    await chat(store, "u", "chat-one", body, []);
    expect((await allItems(store, userPK("u"), { prefix: "DAY#2025-01-05#ENTRY#" }))).toHaveLength(1);
    parse.mockResolvedValue({ ...empty, intent: "correction", items: [], correction: { action: "reduce_fraction", target: "eggs", fraction: 2 / 3 } });
    await chat(store, "u", "chat-two", { ...body, text: "only ate 2/3" }, []);
    const rows = await allItems(store, userPK("u"), { prefix: "DAY#2025-01-05#ENTRY#" });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.data.status === "active")?.data.calories).toBe(100);
    expect(rows.find((r) => r.data.status === "superseded")?.data.superseded_by).toBeTruthy();
    await expect(chat(store, "u", "friday", { ...body, client_time: "2025-01-10T12:00:00+02:00" }, [])).rejects.toThrow(/Not tracking/);
  });
});
describe("historical imports", () => {
  it("commits a source message's multiple rows atomically even when a later row is invalid", async () => {
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "atomic", messages: [
      { ...meal("one"), source_reference: "original-message" },
      { ...meal("two"), calories: undefined, source_reference: "original-message" }
    ] }] });
    const rows = preview.records as Array<{ source_id: string }>;
    await reviewImport(store, "u", String(preview.job_id), { resolutions: rows.map((r) => ({ source_id: r.source_id, action: "include" })) });
    expect(await finish(String(preview.job_id))).toMatchObject({ failed: 2, inserted: 0 });
    expect((await history(store, "u", "2025-01-05", "2025-01-05"))[0]?.entries).toHaveLength(0);
  });
  it("extracts only the latest daily table from an active ChatGPT branch and requires review", async () => {
    const table = (calories: number) => `| Food | Calories |\n| --- | ---: |\n| Eggs | ${calories} |\n\n**Total Intake:** ${calories} kcal`;
    const body = { sources: [{ id: "conversation", current_node: "last", mapping: {
      root: { parent: null, message: { id: "msg1", author: { role: "assistant" }, create_time: Date.parse("2025-01-05T12:00:00Z") / 1000, content: { parts: [table(100)] } } },
      last: { parent: "root", message: { id: "msg2", author: { role: "assistant" }, create_time: Date.parse("2025-01-05T13:00:00Z") / 1000, content: { parts: [table(200)] } } },
      abandoned: { parent: "root", message: { id: "other", author: { role: "assistant" }, create_time: Date.parse("2025-01-05T14:00:00Z") / 1000, content: { parts: [table(999)] } } }
    } }] };
    const preview = await previewImport(store, "u", body, "browser-preview");
    await expect(confirmImport(store, "u", String(preview.job_id))).rejects.toThrow(/Review/);
    const records = preview.records as Array<{ source_id: string }>;
    await reviewImport(store, "u", String(preview.job_id), { resolutions: records.map((r) => ({ source_id: r.source_id, action: "include" })) });
    expect(await finish(String(preview.job_id))).toMatchObject({ inserted: 2, failed: 0, reconciliation: [{ matches: true, ledger_total: 200 }] });
    expect((await history(store, "u", "2025-01-05", "2025-01-05"))[0]?.entries).toHaveLength(1);
    expect(await previewImport(store, "u", body, "browser-preview")).toMatchObject({ job_id: preview.job_id });
    await expect(previewImport(store, "u", { sources: [{ conversation_id: "different", messages: [meal("1")] }] }, "browser-preview")).rejects.toThrow(/reused/);
  });
  it("does not mark a day complete when its imported summary disagrees with its ledger", async () => {
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "mismatch", messages: [
      meal("1"), { id: "sum", timestamp: "2025-01-05T23:00:00+02:00", timezone: "Asia/Jerusalem", kind: "summary", total: 900 }
    ] }] });
    await reviewImport(store, "u", String(preview.job_id), { complete_days: ["2025-01-05"] });
    expect(await finish(String(preview.job_id))).toMatchObject({ reconciliation: [{ matches: false }] });
    expect((await history(store, "u", "2025-01-05", "2025-01-05"))[0]?.completeness).toBe("partial");
  });
  it("reconciles summaries without counting them as meals; overlapping imports are durable duplicates", async () => {
    const sources = [{ conversation_id: "c", messages: [meal("m1"), meal("m2"), { id: "summary", timestamp: "2025-01-05T23:00:00+02:00", timezone: "Asia/Jerusalem", kind: "summary", total: 200 }] }];
    const preview = await previewImport(store, "u", { sources });
    const report = await finish(String(preview.job_id));
    expect(report).toMatchObject({ inserted: 3, failed: 0, reconciliation: [{ source_total: 200, ledger_total: 200, matches: true }] });
    const preview2 = await previewImport(store, "u", { sources });
    expect(await finish(String(preview2.job_id))).toMatchObject({ duplicate: 3, inserted: 0 });
    const days = await history(store, "u", "2025-01-05", "2025-01-05");
    expect(days[0]?.entries).toHaveLength(2); // Identical text, different original messages.
  });
  it("preserves provenance through corrections and fails conflicting source identities explicitly", async () => {
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "c", messages: [
      meal("one", undefined, 150),
      { id: "fix", timestamp: "2025-01-05T13:00:00+02:00", timezone: "Asia/Jerusalem", kind: "correction", target_id: "one", action: "replace", display_name: "Eggs", calories: 100 }
    ] }] });
    expect(await finish(String(preview.job_id))).toMatchObject({ inserted: 1, corrected: 1, failed: 0 });
    expect((await history(store, "u", "2025-01-05", "2025-01-05"))[0]?.entries[0]?.calories).toBe(100);
    const conflict = await previewImport(store, "u", { sources: [{ conversation_id: "c", messages: [meal("one", undefined, 999)] }] });
    expect(await finish(String(conflict.job_id))).toMatchObject({ failed: 1, inserted: 0 });
  });
  it("requires review of timezone/non-tracking ambiguity and never guesses a historical date", async () => {
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "c", messages: [{ ...meal("bad"), timestamp: "unknown", timezone: undefined }] }] });
    await expect(confirmImport(store, "u", String(preview.job_id))).rejects.toThrow(/Review/);
    const records = preview.records as Array<{ source_id: string }>;
    await reviewImport(store, "u", String(preview.job_id), { resolutions: [{ source_id: records[0]!.source_id, action: "skip" }] });
    expect(await finish(String(preview.job_id))).toMatchObject({ skipped: 1, inserted: 0 });
  });
  it("imports more than 18 months with bounded checkpoints and no duplicates after resume", async () => {
    const messages = [];
    for (let offset = 0; offset < 560; offset++) {
      const date = new Date(Date.parse("2024-01-01T12:00:00Z") + offset * 86400000);
      if ([5, 6].includes(date.getUTCDay())) continue;
      messages.push(meal(`day-${offset}`, date.toISOString()));
    }
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "18-months", messages }] });
    const first = await confirmImport(store, "u", String(preview.job_id));
    expect(first.status).toBe("running");
    const report = await finish(String(preview.job_id));
    expect(report).toMatchObject({ inserted: messages.length, failed: 0, pending: 0 });
    expect(await confirmImport(store, "u", String(preview.job_id))).toMatchObject({ inserted: messages.length });
    const days = await history(store, "u", "2024-01-01", "2025-07-13");
    expect(days.flatMap((d) => d.entries)).toHaveLength(messages.length);
  });
});
describe("snapshot analytics", () => {
  it("pins a single generation and user and aggregates daily burn before food/metric joins", () => {
    const sql = analyticsSQL("diet", "ledger", "snapshot-two", "u' OR true --", "2025-01-01", "2025-01-31");
    expect(sql).toContain("snapshot='snapshot-two'");
    expect(sql).toContain("item.pk.s='USER#u'' OR true --'");
    expect(sql).toContain("FROM source WHERE entity='entry' AND d.status.s='active' GROUP BY 1");
    expect(sql).not.toContain("snapshot-one");
    expect(sql).toContain("d.accept_default_burn.bool=true");
    expect(sql).toContain("SELECT cast(day AS date) day FROM bounds");
  });
  it("counts burn once and reports calendar gaps/excluded days instead of inventing deficits", async () => {
    const preview = await previewImport(store, "u", { sources: [{ conversation_id: "c", messages: [meal("1"), meal("2"), { id: "burn", timestamp: "2025-01-05T23:00:00+02:00", timezone: "Asia/Jerusalem", kind: "burn", total: 2000 }] }] });
    await reviewImport(store, "u", String(preview.job_id), { complete_days: ["2025-01-05"] });
    await finish(String(preview.job_id));
    const result = await localTrends(store, "u", "2025-01-05", "2025-01-11");
    const monthly = (result.rows as Array<Record<string, unknown>>).find((r) => r.kind === "monthly");
    expect(monthly).toMatchObject({ intake: 200, burn: 2000, net: -1800, eligible: 5, complete: 1, missing: 4, excluded: 2 });
  });
});
