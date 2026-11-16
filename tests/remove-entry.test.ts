import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import type { Store } from "../src/store.js";
import { allItems } from "../src/store.js";
import { dayState, entrySchema, history, NotFoundError, userPK, write } from "../src/ledger.js";
import { InputError } from "../src/ledger.js";
import { chat } from "../src/chat.js";
import { removeEntry } from "../src/entries.js";
import { createApp } from "../src/server.js";
import type { AppContext } from "../src/types.js";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("../src/llm.js", () => ({ parseMessage: parse, narrateFacts: vi.fn().mockResolvedValue("n/a") }));

let store: Store;
beforeEach(() => {
  store = new SQLiteStore(createDatabase(":memory:"));
  parse.mockReset();
});

const reply = (items: unknown[]) => ({
  intent: "food_log", day_hint: null, items, burn: null, correction: null,
  question: null, needs_clarification: [], notes: ""
});
const item = (raw: string, calories: number) => ({
  raw, food_key: null, match_stage: "estimate", display_name: raw, quantity: 1, unit: "portion",
  calories, calories_source: "estimate", confidence: "high", supersedes_entry_id: null
});
async function log(text: string, clientTime: string, key: string, calories: number) {
  parse.mockResolvedValueOnce(reply([item(text, calories)]));
  return chat(store, "u", key, { text, client_time: clientTime }, []);
}
async function entryIdOf(text: string, day: string): Promise<string> {
  const rows = await allItems(store, userPK("u"), { prefix: `DAY#${day}#ENTRY#` });
  const found = rows.map((r) => entrySchema.parse(r.data)).find((e) => e.display_name === text && e.status === "active");
  if (!found) throw new Error(`no active entry ${text}`);
  return found.id;
}
const activeOn = async (day: string) => (await history(store, "u", day, day))[0]!.entries.map((e) => e.display_name);

describe("removing an entry", () => {
  it("removes it from intake and keeps the row as void", async () => {
    await log("toast", "2026-11-16T08:00:00+02:00", "r1", 150);
    await log("coffee", "2026-11-16T09:00:00+02:00", "r2", 40);
    const id = await entryIdOf("toast", "2026-11-16");
    const { writes, result } = await removeEntry(store, "u", "2026-11-16", id);
    for (const w of writes) await store.transact([w]);
    expect(result).toMatchObject({ already_removed: false, removed: { id, display_name: "toast", calories: 150 } });
    expect(await activeOn("2026-11-16")).toEqual(["coffee"]);
    const row = await store.get(userPK("u"), `DAY#2026-11-16#ENTRY#${id}`);
    expect(entrySchema.parse(row!.data)).toMatchObject({ status: "void", superseded_by: null });
  });

  it("removing the same entry again writes nothing", async () => {
    await log("toast", "2026-11-16T08:00:00+02:00", "r3", 150);
    const id = await entryIdOf("toast", "2026-11-16");
    for (const w of (await removeEntry(store, "u", "2026-11-16", id)).writes) await store.transact([w]);
    const again = await removeEntry(store, "u", "2026-11-16", id);
    expect(again.writes).toEqual([]);
    expect(again.result).toMatchObject({ already_removed: true });
  });

  it("an unknown entry is not found", async () => {
    await expect(removeEntry(store, "u", "2026-11-16", "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an entry replaced by a correction cannot be removed", async () => {
    await log("cheese", "2026-11-16T08:00:00+02:00", "r4", 300);
    const id = await entryIdOf("cheese", "2026-11-16");
    const row = await store.get(userPK("u"), `DAY#2026-11-16#ENTRY#${id}`);
    await store.transact([write(userPK("u"), row!.SK, "entry", { ...row!.data, status: "superseded", superseded_by: "other" }, row)]);
    await expect(removeEntry(store, "u", "2026-11-16", id)).rejects.toBeInstanceOf(InputError);
  });

  it("a day the user confirmed complete reopens to automatic", async () => {
    await log("toast", "2026-11-16T08:00:00+02:00", "r5", 150);
    const d = await dayState(store, "u", "2026-11-16", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] } as never);
    await store.transact([write(userPK("u"), "DAY#2026-11-16#META", "day", { ...d.data, completeness: "complete" }, d.old)]);
    const id = await entryIdOf("toast", "2026-11-16");
    for (const w of (await removeEntry(store, "u", "2026-11-16", id)).writes) await store.transact([w]);
    expect((await dayState(store, "u", "2026-11-16", { timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] } as never)).data.completeness).toBe("missing");
  });
});

describe("DELETE /api/days/:day/entries/:entryId", () => {
  const auth: MiddlewareHandler<AppContext> = async (context, next) => {
    context.set("userId", "u");
    await next();
  };
  const app = () => createApp(store, auth);

  it("removes the entry, replays the same key, and 404s for an unknown entry", async () => {
    await log("toast", "2026-11-16T08:00:00+02:00", "h1", 150);
    const id = await entryIdOf("toast", "2026-11-16");
    const path = `/api/days/2026-11-16/entries/${id}`;
    const first = await app().request(path, { method: "DELETE", headers: { "Idempotency-Key": "remove-toast-1" } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ removed: { display_name: "toast" } });
    const replay = await app().request(path, { method: "DELETE", headers: { "Idempotency-Key": "remove-toast-1" } });
    expect(replay.status).toBe(200);
    expect(await activeOn("2026-11-16")).toEqual([]);
    const missing = await app().request("/api/days/2026-11-16/entries/nope", { method: "DELETE", headers: { "Idempotency-Key": "remove-missing-1" } });
    expect(missing.status).toBe(404);
  });

  it("needs an Idempotency-Key", async () => {
    const response = await app().request("/api/days/2026-11-16/entries/x", { method: "DELETE" });
    expect(response.status).toBe(400);
  });
});
