import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { type Store } from "../src/store.js";
import { dayState, history, userPK, write } from "../src/ledger.js";
import { chat } from "../src/chat.js";
import { burnDayPhrases, parseBurnText } from "../src/parsing.js";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("../src/llm.js", () => ({ parseMessage: parse, narrateFacts: vi.fn().mockResolvedValue("n/a") }));

const pk = userPK("u");
const profile = { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] };
// Morning of 2026-11-02 in Jerusalem; "yesterday" is 2026-11-01.
const MONDAY_MORNING = "2026-11-02T09:00:00+02:00";
let store: Store;
beforeEach(() => { store = new SQLiteStore(createDatabase(":memory:")); parse.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const reply = { intent: "food_log", day_hint: null, items: [], burn: null, correction: null, question: null, needs_clarification: [], notes: "" };
async function say(text: string, key: string) {
  parse.mockResolvedValueOnce(reply);
  return chat(store, "u", key, { text, client_time: MONDAY_MORNING }, []);
}
async function day(d: string) {
  return (await history(store, "u", d, d))[0]!;
}

describe("burn day phrases", () => {
  it.each([
    ["yesterday burned 1642 + 1615", ["yesterday"]],
    ["burned 1642 + 1615 on 2026-11-01", ["2026-11-01"]],
    ["burned so far 3250 on 2026-11-01", ["2026-11-01"]],
    ["Nov 1 I burned 1642 + 1615 calories", ["11-01"]],
    ["November 1st burned 1642 + 1615", ["11-01"]],
    ["1 Nov burned 1642 + 1615", ["11-01"]],
    ["burned 1642 + 1615 on the 1st of november", ["11-01"]],
    ["1550 + 1200", ["today"]]
  ])("reads the burn day in %s", (text, expected) => {
    expect(burnDayPhrases(text)).toEqual(expected);
  });

  it("ignores a day that appears in a clause without a burn", () => {
    expect(burnDayPhrases("today burned 1642 + 1615; same lunch as yesterday")).toEqual(["today"]);
  });

  it("keeps the totals and components unchanged", () => {
    expect(parseBurnText("yesterday burned 1642 + 1615")).toEqual({ total: 3257, components: [1642, 1615] });
  });
});

describe("burn for another day", () => {
  it("'yesterday' records the burn on yesterday and leaves today's burn alone", async () => {
    const result = await say("yesterday burned 1642 + 1615", "b1");
    expect(String(result.message)).toContain("Burn recorded for 2026-11-01: 3257 kcal (1642 + 1615)");
    const yesterday = await day("2026-11-01");
    expect(yesterday.burn).toBe(3257);
    expect(yesterday.burn_source).toBe("recorded");
    expect((await day("2026-11-02")).burn_source).toBe("assumed");
  });

  it("'Nov 1' (no year) records on Nov 1 of the request's year", async () => {
    await say("Nov 1 I burned 1642 + 1615 calories", "b7");
    expect((await day("2026-11-01")).burn).toBe(3257);
    expect((await day("2026-11-02")).burn_source).toBe("assumed");
  });

  it("a month-day that is still ahead is read as the previous year", async () => {
    await say("Dec 30 burned 1000 + 1000", "b8");
    expect((await day("2025-12-30")).burn).toBe(2000);
  });

  it("an explicit ISO date works the same way", async () => {
    await say("burned 1642 + 1615 on 2026-11-01", "b2");
    expect((await day("2026-11-01")).burn).toBe(3257);
  });

  it("a stray 'yesterday' in another clause does not move today's burn", async () => {
    await say("today burned 1642 + 1615; same lunch as yesterday", "b9");
    expect((await day("2026-11-02")).burn).toBe(3257);
    expect((await dayState(store, "u", "2026-11-01", profile)).data.burn_source).toBeNull();
  });

  it("a burn the model reads still goes to the named day", async () => {
    parse.mockResolvedValueOnce({ ...reply, intent: "burn", burn: { total: 3257, components: [] } });
    await chat(store, "u", "b10", { text: "yesterday burned 3257 calories", client_time: MONDAY_MORNING }, []);
    expect((await day("2026-11-01")).burn).toBe(3257);
    expect((await day("2026-11-02")).burn_source).toBe("assumed");
  });

  it("two different burn days in one message are refused and write nothing", async () => {
    await expect(say("yesterday burned 1642 + 1615 and burned 1000 on 2026-10-31", "b11")).rejects.toThrow(/more than one day/);
    expect((await dayState(store, "u", "2026-11-01", profile)).data.burn_source).toBeNull();
    expect((await dayState(store, "u", "2026-10-31", profile)).data.burn_source).toBeNull();
  });

  it("a later burn for the same day replaces the earlier one", async () => {
    await say("yesterday burned 1642 + 1615", "b3");
    await say("yesterday burned 1600 + 1500", "b4");
    expect((await day("2026-11-01")).burn).toBe(3100);
  });

  it("is refused on a day that is not tracked, and writes nothing", async () => {
    const d = await dayState(store, "u", "2026-11-01", profile);
    await store.transact([write(pk, "DAY#2026-11-01#META", "day", { ...d.data, eligibility: "untracked" }, d.old)]);
    await expect(say("yesterday burned 1642 + 1615", "b5")).rejects.toThrow(/Not tracking on 2026-11-01/);
    expect((await dayState(store, "u", "2026-11-01", profile)).data.burn_source).toBeNull();
  });

  it("refuses an invalid date instead of guessing", async () => {
    await expect(say("burned 1642 + 1615 on 2026-13-45", "b6")).rejects.toThrow(/Invalid burn date 2026-13-45/);
  });
});

describe("single model setting", () => {
  it("the deployed BedrockModel default and .env.example BEDROCK_MODEL are the same value", () => {
    const template = readFileSync(new URL("../infra/template.yaml", import.meta.url), "utf8");
    const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const deployed = /BedrockModel:\n(?:.*\n){0,3}?\s+Default: (\S+)/.exec(template)?.[1];
    const local = /^BEDROCK_MODEL=(\S+)$/m.exec(env)?.[1];
    expect(deployed).toMatch(/^(us|eu|jp|global)\./);
    expect(local).toBe(deployed);
  });
});
