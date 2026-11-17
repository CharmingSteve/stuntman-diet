import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import type { Store } from "../src/store.js";
import { entrySchema, history, newDay, profile, userPK, withDefaultBurn, write, type Day } from "../src/ledger.js";
import { repairStoredDay } from "../src/backfill.js";

let store: Store;
const user = "u";
const dayPK = (day: string) => `DAY#${day}#META`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T12:00:00+02:00"));
  store = new SQLiteStore(createDatabase(":memory:"));
});
afterEach(() => { vi.useRealTimers(); });

async function saveDay(day: string, data: Partial<Day> = {}) {
  const base = newDay(day, await profile(store, user));
  await store.transact([write(userPK(user), dayPK(day), "day", { ...base, ...data })]);
}
async function addEntry(day: string, id: string, calories: number) {
  const entry = entrySchema.parse({
    id, day_key: day, occurred_at: `${day}T12:00:00+02:00`, timezone: "Asia/Jerusalem", display_name: id,
    calories, quantity: 1, unit: "portion", status: "active", calories_source: "user_number",
    match_stage: "import", source_id: id, created_at: new Date().toISOString()
  });
  await store.transact([write(userPK(user), `DAY#${day}#ENTRY#${id}`, "entry", entry)]);
}
const row = async (day: string) => (await history(store, user, day, day))[0]!;

describe("tracked days store the assumed burn", () => {
  it("a tracked day with no written burn stores and reports 2000 as assumed", async () => {
    await saveDay("2026-11-15");
    expect((await store.get(userPK(user), dayPK("2026-11-15")))!.data).toMatchObject({ burn_total: 2000, burn_source: "assumed" });
    expect(await row("2026-11-15")).toMatchObject({ burn: 2000, burn_source: "assumed" });
  });

  it("a recorded burn is kept and not replaced by the default", async () => {
    await saveDay("2026-11-15", { burn_total: 2980, burn_source: "recorded" });
    expect(await row("2026-11-15")).toMatchObject({ burn: 2980, burn_source: "recorded" });
  });

  it("an untracked day stores no burn", async () => {
    await saveDay("2026-11-14", { eligibility: "untracked" });
    expect((await store.get(userPK(user), dayPK("2026-11-14")))!.data).toMatchObject({ burn_total: null, burn_source: null });
  });

  it("normalizes the day object in place, so a caller's later completeness reset reaches the queued write", () => {
    const data = { eligibility: "tracked", completeness: "complete", burn_total: null, burn_source: null };
    const queued = write(userPK(user), dayPK("2026-11-16"), "day", data as unknown as Record<string, unknown>);
    expect(queued.item.data).toBe(data);
    expect(data).toMatchObject({ burn_total: 2000, burn_source: "assumed" });
    data.completeness = "missing";
    expect(queued.item.data.completeness).toBe("missing");
  });

  it("switching a day to untracked clears the assumed burn, and back to tracked restores it", () => {
    const off = withDefaultBurn({ eligibility: "untracked", burn_total: 2000, burn_source: "assumed" });
    expect(off).toMatchObject({ burn_total: null, burn_source: null });
    expect(withDefaultBurn({ eligibility: "tracked", burn_total: null, burn_source: null })).toMatchObject({ burn_total: 2000, burn_source: "assumed" });
  });
});

describe("automatic completeness", () => {
  it("a past day with entries and no stored choice becomes complete on the next day", async () => {
    await saveDay("2026-11-16");
    await addEntry("2026-11-16", "a", 500);
    expect((await row("2026-11-16")).completeness).toBe("partial");
    vi.setSystemTime(new Date("2026-11-17T08:00:00+02:00"));
    expect(await row("2026-11-16")).toMatchObject({ completeness: "complete", net: 500 - 2000 });
  });

  it("a stored partial stays partial, because the owner chose it", async () => {
    await saveDay("2026-11-15", { completeness: "partial" });
    await addEntry("2026-11-15", "a", 500);
    vi.setSystemTime(new Date("2026-11-17T08:00:00+02:00"));
    expect((await row("2026-11-15")).completeness).toBe("partial");
  });
});

describe("repairStoredDay (production backfill rule)", () => {
  const base: Day = {
    day_key: "2026-11-10", timezone: "Asia/Jerusalem", eligibility: "tracked", completeness: "missing",
    burn_total: null, burn_source: null, accept_default_burn: false, burn_components: []
  };

  it("stores the assumed burn on a tracked day, and leaves a stored partial alone unless the day is listed", () => {
    const repaired = repairStoredDay({ ...base, completeness: "partial" }, "2026-11-17");
    expect(repaired).toMatchObject({ completeness: "partial", burn_total: 2000, burn_source: "assumed" });
  });

  it("reopens a past partial only when the operator lists that day", () => {
    const listed = new Set(["2026-11-10"]);
    expect(repairStoredDay({ ...base, completeness: "partial" }, "2026-11-17", listed).completeness).toBe("missing");
  });

  it("never reopens today's record, even when listed, since it may be a deliberate mid-day stop", () => {
    const today = { ...base, day_key: "2026-11-17", completeness: "partial" as const };
    expect(repairStoredDay(today, "2026-11-17", new Set(["2026-11-17"])).completeness).toBe("partial");
  });

  it("keeps a user-confirmed complete day and a recorded burn", () => {
    const done = { ...base, completeness: "complete" as const, burn_total: 3257, burn_source: "recorded" as const };
    expect(repairStoredDay(done, "2026-11-17")).toMatchObject({ completeness: "complete", burn_total: 3257, burn_source: "recorded" });
  });
});
