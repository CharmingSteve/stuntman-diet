import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems } from "../src/store.js";
import { history, userPK } from "../src/ledger.js";
import { chat } from "../src/chat.js";
import { parseWeightText } from "../src/weight.js";
import { instantAt, clockTime } from "../src/time.js";

// The weight path returns before any model call. If it ever reached the model, the Bedrock call would fail here.
describe("parseWeightText", () => {
  it("records an explicit kilogram weight with no time", () => {
    expect(parseWeightText("I weigh 84.2 kg")).toEqual({ kind: "record", value: 84.2, time: null });
    expect(parseWeightText("weight 84.2 kg")).toEqual({ kind: "record", value: 84.2, time: null });
    expect(parseWeightText("84.2 kg this morning")).toEqual({ kind: "record", value: 84.2, time: null });
    expect(parseWeightText("my weight is 84.2 kg")).toEqual({ kind: "record", value: 84.2, time: null });
  });

  it("uses a time the user gives, in 24-hour or am/pm form", () => {
    expect(parseWeightText("84.2 kg at 7")).toEqual({ kind: "record", value: 84.2, time: { hour: 7, minute: 0 } });
    expect(parseWeightText("84.2 kg at 07:30")).toEqual({ kind: "record", value: 84.2, time: { hour: 7, minute: 30 } });
    expect(parseWeightText("this morning at 7pm: 84.2 kg")).toEqual({ kind: "record", value: 84.2, time: { hour: 19, minute: 0 } });
    expect(parseWeightText("84.2 kg at 12am")).toEqual({ kind: "record", value: 84.2, time: { hour: 0, minute: 0 } });
  });

  it("asks for the unit when none is given, and never converts pounds", () => {
    expect(parseWeightText("weight 84.2")).toMatchObject({ kind: "refuse", message: expect.stringContaining("kilograms (kg) or pounds (lb)") });
    expect(parseWeightText("84.2 lb")).toMatchObject({ kind: "refuse", message: expect.stringContaining("Nothing was recorded") });
    expect(parseWeightText("weight 185 lbs")).toMatchObject({ kind: "refuse" });
  });

  it("refuses values outside 20 to 500 kg", () => {
    expect(parseWeightText("weight 19 kg")).toMatchObject({ kind: "refuse", message: expect.stringContaining("between 20 and 500") });
    expect(parseWeightText("weight 501 kg")).toMatchObject({ kind: "refuse" });
  });

  it("refuses a weight mixed with other content rather than guessing", () => {
    expect(parseWeightText("weight 84.2 kg and an egg")).toMatchObject({ kind: "refuse", message: expect.stringContaining("its own message") });
  });

  it("leaves food and other messages to the normal parser", () => {
    for (const text of ["200 g rice", "1 kg of rice", "2 eggs", "weigh the cheese 200g", "cheese 30g", "burned 1642 + 1615"]) {
      expect(parseWeightText(text), text).toBeNull();
    }
  });
});

describe("instantAt", () => {
  it("converts a local wall-clock time to the right instant across the offset", () => {
    expect(instantAt("2026-11-17", 7, 30, "Asia/Jerusalem").toISOString()).toBe("2026-11-17T05:30:00.000Z");
    expect(clockTime(instantAt("2026-07-01", 7, 30, "Asia/Jerusalem"), "Asia/Jerusalem")).toBe("07:30");
  });
});

describe("chat records a posted weight as a metric", () => {
  const user = "u";
  const post = (store: SQLiteStore, text: string, clientTime = "2026-11-17T20:00:00+02:00", key = text) =>
    chat(store, user, key, { text, client_time: clientTime }, []);
  const weights = async (store: SQLiteStore) =>
    (await allItems(store, userPK(user), { prefix: "DAY#" })).filter((r) => r.entity === "metric");

  it("stores the weight with the time the user gave and confirms it in one line", async () => {
    const store = new SQLiteStore(createDatabase(":memory:"));
    const reply = await post(store, "I weigh 84.2 kg at 7");
    expect(reply.message).toBe("Recorded weight 84.2 kg on 2026-11-17 at 07:00 (Asia/Jerusalem).");
    const [row] = await weights(store);
    expect(row!.data).toMatchObject({ metric: "weight", value: 84.2, unit: "kg", day_key: "2026-11-17", occurred_at: "2026-11-17T05:00:00.000Z", source: "user_input" });
  });

  it("uses the request's time when none is given", async () => {
    const store = new SQLiteStore(createDatabase(":memory:"));
    await post(store, "84.2 kg this morning", "2026-11-17T07:45:00+02:00");
    expect((await weights(store))[0]!.data).toMatchObject({ day_key: "2026-11-17", occurred_at: "2026-11-17T05:45:00.000Z" });
  });

  it("records nothing for a weight with no unit, and says what to send", async () => {
    const store = new SQLiteStore(createDatabase(":memory:"));
    const reply = await post(store, "weight 84.2");
    expect(reply.message).toContain("Which unit");
    expect(await weights(store)).toEqual([]);
  });

  it("never writes a weight for another day, and keeps weight out of food and calorie totals", async () => {
    const store = new SQLiteStore(createDatabase(":memory:"));
    await post(store, "weight 84.2 kg");
    expect(await allItems(store, userPK(user), { prefix: "DAY#2026-11-16#METRIC#" })).toEqual([]);
    const today = await history(store, user, "2026-11-17", "2026-11-17");
    expect(today[0]!.entries).toEqual([]);
    expect(today[0]!.intake).toBeFalsy();
  });
});
