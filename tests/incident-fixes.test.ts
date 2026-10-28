import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, type Store } from "../src/store.js";
import { dayState, history, userPK, write } from "../src/ledger.js";
import { chat, looksLikeBurn } from "../src/chat.js";
import { FIX_SYNTAX, parseFixCommand } from "../src/fixes.js";
import { createApp } from "../src/server.js";
import type { AppContext } from "../src/types.js";

// The model is stubbed with the exact output it produced for the incident.
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("../src/llm.js", () => ({ parseMessage: parse, narrateFacts: vi.fn().mockResolvedValue("n/a") }));

const day = "2026-10-27", pk = userPK("u");
let store: Store;
beforeEach(() => { store = new SQLiteStore(createDatabase(":memory:")); parse.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const reply = (over: Record<string, unknown> = {}) => ({
  intent: "food_log", day_hint: null, items: [], burn: null, correction: null,
  question: null, needs_clarification: [], notes: "", ...over
});
const food = (raw: string, display: string, calories: number, stage: "user_number" | "estimate" = "user_number") => ({
  raw, food_key: null, match_stage: stage, display_name: display, quantity: 1, unit: "portion",
  calories, calories_source: stage, confidence: "high", supersedes_entry_id: null
});
async function say(text: string, clientTime: string, key: string, model = reply()) {
  parse.mockResolvedValueOnce(model);
  return chat(store, "u", key, { text, client_time: clientTime }, []);
}
async function entries(d = day) {
  return (await history(store, "u", d, d))[0]!.entries;
}
async function state(d = day) {
  return (await history(store, "u", d, d))[0]!;
}
async function snapshot() {
  return JSON.stringify(await allItems(store, pk, { prefix: "DAY#" }));
}
async function addRaw(SK: string, data: Record<string, unknown>) {
  await store.transact([write(pk, SK, "entry", data)]);
}
// The 22:44 row as it sits in production (occurred 20:44:50Z = 22:44 Jerusalem).
const incidentRow = (id: string, calories = 2980) => ({
  id, day_key: day, occurred_at: "2026-10-27T20:44:50.804Z", timezone: "Asia/Jerusalem", food_id: null,
  raw_text: "burned 1430 + 1550 2,980", display_name: "burned 1430 + 1550 2,980", quantity: null, unit: "unit",
  calories, calories_source: "estimate", match_stage: "estimate", status: "active", superseded_by: null,
  image_key: null, created_at: "2026-10-27T20:44:52.788Z"
});
const yogurtRow = {
  id: "yogurt", day_key: day, occurred_at: "2026-10-27T20:41:02.210Z", timezone: "Asia/Jerusalem", food_id: null,
  raw_text: "vegan yogurt 125 calories", display_name: "Vegan yogurt (125 calories)", quantity: null, unit: "portion",
  calories: 125, calories_source: "user_number", match_stage: "user_number", status: "active", superseded_by: null,
  image_key: null, created_at: "2026-10-27T20:41:05.243Z"
};
const T_2244 = "2026-10-27T22:44:30+02:00";

describe("fix command grammar", () => {
  it.each([
    ["fix 10:44 PM delete", { date: null, hour: 22, minute: 44, name: "", action: { kind: "delete" } }],
    ["fix 22:44 burn 1430 + 1550", { date: null, hour: 22, minute: 44, name: "", action: { kind: "burn", components: [1430, 1550] } }],
    ["fix 10:44 PM burn", { date: null, hour: 22, minute: 44, name: "", action: { kind: "burn", components: [] } }],
    ["fix 10:41 PM calories 150", { date: null, hour: 22, minute: 41, name: "", action: { kind: "calories", calories: 150 } }],
    ["fix 2026-10-27 22:44 delete", { date: "2026-10-27", hour: 22, minute: 44, name: "", action: { kind: "delete" } }],
    ["fix 11:41 AM crackers delete", { date: null, hour: 11, minute: 41, name: "crackers", action: { kind: "delete" } }],
    ["fix 12:05 AM delete", { date: null, hour: 0, minute: 5, name: "", action: { kind: "delete" } }],
    ["fix 12:30 PM delete", { date: null, hour: 12, minute: 30, name: "", action: { kind: "delete" } }],
    ["fix 10:44pm delete", { date: null, hour: 22, minute: 44, name: "", action: { kind: "delete" } }],
    ["fix 10:44 PM burned 2980", { date: null, hour: 22, minute: 44, name: "", action: { kind: "burn", components: [2980] } }]
  ])("reads %s", (text, command) => {
    expect(parseFixCommand(text)).toEqual({ command });
  });

  it.each([
    "fix", "fix 10:44 PM", "fix 25:00 delete", "fix 13:00 PM delete", "fix 0:00 PM delete", "fix 10:61 delete",
    "fix 10:44 PM delete now", "fix 10:44 PM burn lots", "fix 10:44 PM calories 0", "fix 10:44 PM calories lots",
    "fix 2026-02-30 10:44 delete", "fix 10:44 PM", "fix tonight delete"
  ])("refuses malformed %s with the syntax instead of calling the model", (text) => {
    const parsed = parseFixCommand(text);
    expect(parsed).toMatchObject({ error: expect.stringContaining("Use: fix 10:44 PM delete") });
  });

  it.each(["burnt toast", "fixed my lunch", "250g cottage cheese", "1550 + 1200 burned"])("does not treat %s as a fix", (text) => {
    expect(parseFixCommand(text)).toBeNull();
  });

  it("every documented syntax line parses", () => {
    for (const line of FIX_SYNTAX) expect(parseFixCommand(line)).toHaveProperty("command");
  });

  it("the log box shows every documented syntax line", () => {
    const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    for (const line of FIX_SYNTAX) expect(html).toContain(line);
  });
});

describe("burn is never recorded as food", () => {
  it("drops a burn echoed by the model and records the burn total instead (the 22:42 incident)", async () => {
    await say("burned 1430 + 1550", "2026-10-27T22:42:18+02:00", "k1", reply({
      items: [food("burned 1430 + 1550", "burned 1430 + 1550", 2980, "estimate")]
    }));
    expect((await entries()).map((e) => e.display_name)).toEqual([]);
    const d = await state();
    expect(d.burn).toBe(2980);
    expect(d.burn_source).toBe("recorded");
  });

  it("refuses a correction whose replacement is a burn, and writes nothing", async () => {
    await say("crackers 84 calories", "2026-10-27T11:41:00+02:00", "k2", reply({ items: [food("crackers 84 calories", "Crackers (18g)", 84)] }));
    const before = await snapshot();
    await expect(say("burned 1430 + 1550 2,980", "2026-10-27T22:44:30+02:00", "k3", reply({
      correction: { target: "crackers", action: "replace", fraction: null },
      items: [food("burned 1430 + 1550 2,980", "burned 1430 + 1550 2,980", 2980, "estimate")]
    }))).rejects.toThrow(/replacement/i);
    expect(await snapshot()).toBe(before);
  });

  it("classifies burn text by words and by the two-number sum, not by calories", () => {
    expect(looksLikeBurn({ raw: "burned 1430 + 1550", display_name: "x" })).toBe(true);
    expect(looksLikeBurn({ raw: "1550 + 1200", display_name: "x" })).toBe(true);
    expect(looksLikeBurn({ raw: "burnt toast", display_name: "Toast" })).toBe(false);
    expect(looksLikeBurn({ raw: "2 eggs", display_name: "Eggs" })).toBe(false);
  });
});

describe("fix repairs entries", () => {
  beforeEach(async () => {
    await addRaw(`DAY#${day}#ENTRY#incident`, incidentRow("incident"));
    await addRaw(`DAY#${day}#ENTRY#yogurt`, yogurtRow);
  });

  it("delete voids the bad 10:44 PM row and the intake drops by exactly its calories", async () => {
    const before = (await entries()).reduce((n, e) => n + e.calories, 0);
    expect(before).toBe(2980 + 125);
    parse.mockClear();
    const result = await chat(store, "u", "f1", { text: "fix 10:44 PM delete", client_time: T_2244 }, []);
    expect(parse).not.toHaveBeenCalled();
    expect(result.message).toContain('Deleted 10:44 PM entry "burned 1430 + 1550 2,980"');
    expect((await entries()).map((e) => e.id)).toEqual(["yogurt"]);
    expect((await entries()).reduce((n, e) => n + e.calories, 0)).toBe(125);
    const stored = (await allItems(store, pk, { prefix: `DAY#${day}#ENTRY#incident` }))[0]!;
    expect(stored.data).toMatchObject({ status: "void", superseded_by: null });
  });

  it("burn moves the 10:44 PM calories into the day's burn, not intake", async () => {
    await chat(store, "u", "f2", { text: "fix 10:44 PM burn", client_time: T_2244 }, []);
    expect((await entries()).map((e) => e.id)).toEqual(["yogurt"]);
    const d = await state();
    expect(d.burn).toBe(2980);
    expect(d.burn_source).toBe("recorded");
  });

  it("burn with components records them, and works for a fix on another day by date", async () => {
    await chat(store, "u", "f3", { text: "fix 2026-10-27 22:44 burn 1430 + 1550", client_time: "2026-10-28T09:00:00+02:00" }, []);
    expect((await entries()).map((e) => e.id)).toEqual(["yogurt"]);
    const d = await state();
    expect(d.burn).toBe(2980);
    const meta = (await allItems(store, pk, { prefix: `DAY#${day}#META` }))[0]!;
    expect(meta.data.burn_components).toEqual([1430, 1550]);
  });

  it("calories keeps history: the old row is superseded and points at the replacement", async () => {
    await chat(store, "u", "f4", { text: "fix 10:41 PM calories 150", client_time: T_2244 }, []);
    const active = await entries();
    expect(active.map((e) => e.calories).sort((a, b) => a - b)).toEqual([150, 2980]);
    const old = (await allItems(store, pk, { prefix: `DAY#${day}#ENTRY#yogurt` }))[0]!;
    expect(old.data.status).toBe("superseded");
    expect(old.data.superseded_by).toBe(active.find((e) => e.calories === 150)!.id);
  });

  it("a minute with several entries is refused until a name narrows it, with nothing written", async () => {
    await addRaw(`DAY#${day}#ENTRY#protein`, { ...yogurtRow, id: "protein", occurred_at: "2026-10-27T20:44:10.000Z", display_name: "Protein drink", raw_text: "protein drink 100 calories", calories: 100 });
    const before = await snapshot();
    await expect(chat(store, "u", "f5", { text: "fix 10:44 PM delete", client_time: T_2244 }, [])).rejects.toThrow(/2 active entries at 10:44 PM.*Add a name/);
    expect(await snapshot()).toBe(before);
    await chat(store, "u", "f6", { text: "fix 10:44 PM burned delete", client_time: T_2244 }, []);
    expect((await entries()).map((e) => e.display_name)).toEqual(["Vegan yogurt (125 calories)", "Protein drink"]);
  });

  it("a time with no entry is refused and lists what is logged that day", async () => {
    await expect(chat(store, "u", "f7", { text: "fix 9:00 AM delete", client_time: T_2244 }, []))
      .rejects.toThrow(/No active entry at 9:00 AM on 2026-10-27\. Active entries that day: .*10:44 PM burned 1430 \+ 1550 2,980 \(2980 kcal\)/);
  });

  it("burn on a day not tracked is refused", async () => {
    const d = await dayState(store, "u", day, { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] });
    await store.transact([write(pk, `DAY#${day}#META`, "day", { ...d.data, eligibility: "untracked" }, d.old)]);
    await expect(chat(store, "u", "f8", { text: "fix 10:44 PM burn", client_time: T_2244 }, [])).rejects.toThrow(/Not tracking/);
  });

  it("the same key replayed does not void twice", async () => {
    await chat(store, "u", "f9", { text: "fix 10:44 PM delete", client_time: T_2244 }, []);
    const once = await snapshot();
    await chat(store, "u", "f9", { text: "fix 10:44 PM delete", client_time: T_2244 }, []);
    expect(await snapshot()).toBe(once);
  });

  it("the HTTP route returns the fix result and a 400 with the syntax for a bad fix", async () => {
    const db = createDatabase(":memory:");
    const routeStore = new SQLiteStore(db);
    await routeStore.transact([write(pk, `DAY#${day}#ENTRY#incident`, "entry", incidentRow("incident"))]);
    const auth: MiddlewareHandler<AppContext> = async (c, next) => { c.set("userId", "u"); await next(); };
    const app = createApp(db, auth);
    const bad = await app.request("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "route-bad-1" },
      body: JSON.stringify({ text: "fix 10:44 PM", client_time: T_2244 })
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining("Use: fix 10:44 PM delete") });
    const good = await app.request("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "route-good-1" },
      body: JSON.stringify({ text: "fix 10:44 PM delete", client_time: T_2244 })
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ message: expect.stringContaining("Deleted 10:44 PM") });
    db.close();
  });
});

describe("a new day assumes a 2000 kcal burn unless one is written", () => {
  it("the first message of a day shows the assumed burn in the table", async () => {
    const result = await say("protein drink 200 calories", "2026-10-28T08:00:00+02:00", "d1", reply({
      items: [food("protein drink 200 calories", "Protein drink", 200)]
    }));
    expect(String(result.message)).toContain("**Calories Burned:** 2000 kcal (assumed)");
    const d = await state("2026-10-28");
    expect(d.burn).toBe(2000);
    expect(d.burn_source).toBe("assumed");
    expect(d.net).toBeNull();
  });

  it("a complete tracked day with no burn written nets against 2000", async () => {
    await say("protein drink 200 calories", "2026-10-28T08:00:00+02:00", "d2", reply({ items: [food("protein drink 200 calories", "Protein drink", 200)] }));
    const d = await dayState(store, "u", "2026-10-28", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] });
    await store.transact([write(pk, "DAY#2026-10-28#META", "day", { ...d.data, completeness: "complete" }, d.old)]);
    expect((await state("2026-10-28")).net).toBe(200 - 2000);
  });

  it("a written burn overrides the assumed default", async () => {
    await say("1550 + 1200", "2026-10-28T20:00:00+02:00", "d3");
    const d = await state("2026-10-28");
    expect(d.burn).toBe(2750);
    expect(d.burn_source).toBe("recorded");
  });

  it("a non-tracking day has no burn at all", async () => {
    const d = await dayState(store, "u", "2026-10-30", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] });
    await store.transact([write(pk, "DAY#2026-10-30#META", "day", { ...d.data, eligibility: "untracked" }, d.old)]);
    expect((await state("2026-10-30")).burn).toBeNull();
  });
});
