import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, type Store } from "../src/store.js";
import { entrySchema, history, userPK, write, dayState } from "../src/ledger.js";
import { chat, possiblyMissingFoods } from "../src/chat.js";
import { analysisWindow } from "../src/analysis.js";
import type { FoodRecord } from "../src/types.js";

const { parse, narrate } = vi.hoisted(() => ({ parse: vi.fn(), narrate: vi.fn() }));
vi.mock("../src/llm.js", () => ({ parseMessage: parse, narrateFacts: narrate }));

let store: Store;
beforeEach(() => {
  store = new SQLiteStore(createDatabase(":memory:"));
  parse.mockReset();
  narrate.mockReset().mockResolvedValue("answer");
});

const reply = (over: Record<string, unknown> = {}) => ({
  intent: "food_log", day_hint: null, items: [], burn: null, correction: null,
  question: null, needs_clarification: [], notes: "", ...over
});
const item = (raw: string, over: Record<string, unknown> = {}) => ({
  raw, food_key: null, match_stage: "estimate", display_name: raw, quantity: 1, unit: "portion",
  calories: 300, calories_source: "estimate", confidence: "high", supersedes_entry_id: null, ...over
});
async function say(text: string, clientTime: string, key: string, model: Record<string, unknown> = reply(), foods: FoodRecord[] = []) {
  parse.mockResolvedValueOnce(model);
  return chat(store, "u", key, { text, client_time: clientTime }, foods);
}
const dayEntries = async (d: string) => (await history(store, "u", d, d))[0]!.entries;
const dayRow = async (d: string) => (await history(store, "u", d, d))[0]!;

const cheese: FoodRecord = { id: "cheese", name: "Cheese", aliases: ["cheese"], category: "dairy", basis: { type: "per_100g", calories_per_100g: 300 } };
const bread: FoodRecord = { id: "bread", name: "Bread", aliases: ["bread"], category: "starches", basis: { type: "per_100g", calories_per_100g: 250 } };
const pb = (id: string, per100: number): FoodRecord => ({ id, name: id, aliases: ["peanut butter"], category: "spreads", basis: { type: "per_100g", calories_per_100g: per100 } });

describe("#8 never block on unsure input", () => {
  it("records an ambiguous item instead of dropping it, and says what was unsure", async () => {
    const result = await say("200g peanut butter", "2026-11-16T12:00:00+02:00", "a1",
      reply({ items: [item("200g peanut butter", { food_key: null, match_stage: "alias", quantity: 200, unit: "g", calories: null, calories_source: "db" })] }),
      [pb("pure_pb", 590), pb("candied_pb", 700)]);
    expect(await dayEntries("2026-11-16")).toHaveLength(1);
    expect(result.unclear).toEqual(expect.arrayContaining([expect.stringContaining("peanut butter")]));
  });

  it("flags a catalog food the model merged away, without refusing to record", async () => {
    const result = await say("two cheeses mixed with bread", "2026-11-16T12:00:00+02:00", "a2",
      reply({ items: [item("two cheeses mixed", { food_key: "cheese", match_stage: "alias", quantity: 2, unit: "portion", calories: 600 })] }),
      [cheese, bread]);
    expect(await dayEntries("2026-11-16")).toHaveLength(1);
    expect(result.unclear).toEqual(expect.arrayContaining([expect.stringContaining("Bread")]));
  });

  it("shows the model's own needs_clarification as a note, not as a refusal", async () => {
    const result = await say("some soup", "2026-11-16T12:00:00+02:00", "a3",
      reply({ items: [item("some soup")], needs_clarification: ["Which soup?"] }));
    expect(await dayEntries("2026-11-16")).toHaveLength(1);
    expect(result.unclear).toEqual(["Which soup?"]);
  });

  it("a failed correction lists the entries it could have meant", async () => {
    await say("pizza slice", "2026-11-16T12:00:00+02:00", "a4", reply({ items: [item("pizza slice", { calories: 285 })] }));
    await say("salad", "2026-11-16T13:00:00+02:00", "a5", reply({ items: [item("salad", { calories: 120 })] }));
    const error = await say("no longer ate the sandwich", "2026-11-16T14:00:00+02:00", "a6",
      reply({ correction: { target: "sandwich", action: "void", fraction: null } })).catch((e: Error) => e);
    expect(String(error.message ?? error)).toMatch(/pizza slice.*285 kcal/s);
    expect(String(error.message ?? error)).toMatch(/salad.*120 kcal/s);
  });
});

describe("#9 completeness", () => {
  it("a past day with entries is complete automatically", async () => {
    await say("lunch", "2026-11-15T13:00:00+02:00", "c1", reply({ items: [item("lunch")] }));
    expect((await dayRow("2026-11-15")).completeness).toBe("complete");
  });

  it("today with entries is still partial while the day is in progress", async () => {
    await say("lunch", "2026-11-16T13:00:00+02:00", "c2", reply({ items: [item("lunch")] }));
    expect((await dayRow("2026-11-16")).completeness).toBe("partial");
  });

  it("a day flagged incomplete stays partial after it has ended", async () => {
    await say("lunch", "2026-11-15T13:00:00+02:00", "c3", reply({ items: [item("lunch")] }));
    const d = await dayState(store, "u", "2026-11-15", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] } as never);
    await store.transact([write(userPK("u"), "DAY#2026-11-15#META", "day", { ...d.data, completeness: "partial" }, d.old)]);
    expect((await dayRow("2026-11-15")).completeness).toBe("partial");
  });

  it("a past day with no entries stays missing (no log is not zero intake)", async () => {
    expect((await dayRow("2026-11-14")).completeness).toBe("missing");
  });
});

describe("#9 cross-day corrections and splits", () => {
  it("corrects yesterday's entry, restating yesterday's day", async () => {
    await say("cheese", "2026-11-15T20:00:00+02:00", "d1", reply({ items: [item("cheese", { calories: 300 })] }));
    await say("only ate half of the cheese", "2026-11-16T08:00:00+02:00", "d2", reply({
      correction: { target: "cheese", action: "reduce_fraction", fraction: 0.5 }
    }));
    // history() returns only active entries, so read the ledger rows to check the superseded original too.
    const rows = (await allItems(store, userPK("u"), { prefix: "DAY#2026-11-15#ENTRY#" })).map((r) => entrySchema.parse(r.data));
    expect(rows.map((e) => [e.status, e.day_key, e.calories])).toEqual(expect.arrayContaining([["superseded", "2026-11-15", 300], ["active", "2026-11-15", 150]]));
  });

  it("splits: half corrected on yesterday, the other half recorded today", async () => {
    await say("cheese", "2026-11-15T20:00:00+02:00", "d3", reply({ items: [item("cheese", { calories: 300 })] }));
    await say("ate half yesterday, the other half now", "2026-11-16T08:00:00+02:00", "d4", reply({
      correction: { target: "cheese", action: "reduce_fraction", fraction: 0.5 },
      items: [item("cheese, other half", { calories: 150 })]
    }));
    expect((await dayEntries("2026-11-16")).map((e) => e.calories)).toEqual([150]);
    expect((await dayEntries("2026-11-15")).filter((e) => e.status === "active").map((e) => e.calories)).toEqual([150]);
  });
});

describe("#17 health questions over a month", () => {
  it("gives the model a daily picture of last month, not only today", async () => {
    await say("breakfast", "2026-10-13T08:00:00+03:00", "q0", reply({ items: [item("breakfast", { calories: 400 })] }));
    parse.mockResolvedValueOnce(reply({ intent: "question", question: "How was my intake last month?" }));
    await chat(store, "u", "q1", { text: "How was my intake last month?", client_time: "2026-11-16T12:00:00+02:00" }, []);
    const facts = narrate.mock.calls[0]![1] as { days?: Array<{ date: string; intake: number }> };
    expect(facts.days?.find((d) => d.date === "2026-10-13")).toMatchObject({ intake: 400 });
  });
});

describe("question windows", () => {
  it("last month is the previous calendar month", () => {
    expect(analysisWindow("How was last month?", "2026-11-16")).toEqual({ from: "2026-10-01", to: "2026-10-31", label: "last month" });
  });
  it("last month from January is December of the year before", () => {
    expect(analysisWindow("last month", "2026-01-05")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("a stated span is honored and capped", () => {
    expect(analysisWindow("last 10 days", "2026-11-16")).toMatchObject({ from: "2026-11-07", to: "2026-11-16" });
    expect(analysisWindow("last 500 days", "2026-11-16")).toMatchObject({ from: "2026-08-17", to: "2026-11-16" });
  });
  it("defaults to the last 31 days", () => {
    expect(analysisWindow("how am I doing?", "2026-11-16")).toMatchObject({ from: "2026-10-17", to: "2026-11-16" });
  });
});

describe("unclear-note matching", () => {
  it("does not flag a food the message only contains as part of another word", () => {
    expect(possiblyMissingFoods("steak and eggs", [{ raw: "steak and eggs", display_name: "steak and eggs", food_key: "steak" }],
      [{ id: "tea", name: "Tea", aliases: ["tea"], category: "drinks", basis: { calories: 2 } } as FoodRecord])).toEqual([]);
  });
  it("flags a named food with punctuation around it", () => {
    expect(possiblyMissingFoods("eggs, bread.", [{ raw: "eggs", display_name: "Eggs", food_key: "eggs" }],
      [{ id: "bread", name: "Bread", aliases: [], category: "starches", basis: { calories: 80 } } as FoodRecord]).length).toBe(1);
  });
});

describe("a confirmed day reopens to automatic when it changes", () => {
  it("logging on a day the user confirmed complete returns it to automatic", async () => {
    await say("lunch", "2026-11-15T13:00:00+02:00", "r1", reply({ items: [item("lunch")] }));
    const d = await dayState(store, "u", "2026-11-15", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] } as never);
    await store.transact([write(userPK("u"), "DAY#2026-11-15#META", "day", { ...d.data, completeness: "complete" }, d.old)]);
    await say("a late snack", "2026-11-15T21:00:00+02:00", "r2", reply({ items: [item("a late snack")] }));
    expect((await dayRow("2026-11-15")).completeness_setting).toBe("missing");
  });
});
