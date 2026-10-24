import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, StoreConflict, type StoreWrite } from "../src/store.js";
import { digest, entrySchema, history, userPK, write } from "../src/ledger.js";
import { confirmImport, previewImport, reviewImport } from "../src/imports.js";
import { normalizeBrowserSources } from "../src/browser-import.js";

const day = "2025-01-05", nextDay = "2025-01-06", pk = userPK("u");
type Food = [string, number];
type RecordRow = { source_id: string; kind: string; status?: string; error?: string };
let store: SQLiteStore;
beforeEach(() => { store = new SQLiteStore(createDatabase(":memory:")); });
afterEach(() => { store.close(); vi.restoreAllMocks(); });

function browser(id: string, hour: number, foods: Food[], date = day) {
  return { sources: [{ id: "conversation", messages: [{
    id, role: "assistant", timestamp: `${date}T${String(hour).padStart(2, "0")}:00:00Z`,
    content: `| Food | Calories |\n| --- | ---: |\n${foods.map(([name, calories]) => `| ${name} | ${calories} |`).join("\n")}\n\n**Total Intake:** ${foods.reduce((sum, [, calories]) => sum + calories, 0)} kcal`
  }] }] };
}
async function prepared(body: unknown, assignedDay?: string) {
  const preview = await previewImport(store, "u", body);
  await reviewImport(store, "u", String(preview.job_id), {
    resolutions: (preview.records as RecordRow[]).map((r) => ({ source_id: r.source_id, action: "include", ...(assignedDay ? { day: assignedDay } : {}) })),
    complete_days: [assignedDay ?? day]
  });
  return String(preview.job_id);
}
async function finish(id: string) {
  let report = await confirmImport(store, "u", id);
  for (let n = 0; n < 50 && report.status === "running"; n++) report = await confirmImport(store, "u", id);
  expect(report.status).toBe("complete");
  return report;
}
async function active(date = day) {
  return (await history(store, "u", date, date))[0]!.entries;
}
function isRevision(writes: StoreWrite[]) {
  return writes.some((w) => w.item.entity === "browser_table_revision");
}

describe("durable browser daily-table revisions", () => {
  it.each(["include", "skip"] as const)("does not mark a failed source day complete and preserves explicit %s decisions", async (action) => {
    const valid = {
      id: "valid", kind: "meal", display_name: "Eggs", calories: 100,
      timestamp: `${day}T12:00:00Z`, timezone: "Asia/Jerusalem", source_reference: "valid-group"
    };
    const preview = await previewImport(store, "u", { sources: [{
      conversation_id: "partial-import", messages: [
        valid, { ...valid, id: "invalid", calories: undefined, source_reference: "invalid-group" }
      ]
    }] });
    const records = preview.records as RecordRow[], id = String(preview.job_id);
    await reviewImport(store, "u", id, {
      resolutions: records.map((r, index) => ({ source_id: r.source_id, action: index === 0 ? "include" : action })),
      complete_days: [day]
    });
    expect(await finish(id)).toMatchObject({
      inserted: 1, failed: action === "include" ? 1 : 0, skipped: action === "skip" ? 1 : 0
    });
    expect((await history(store, "u", day, day))[0]).toMatchObject({
      completeness: action === "include" ? "partial" : "complete"
    });
    expect(await active()).toHaveLength(1);
  });

  it("replaces earlier tables atomically, including unchanged rows, without touching manual/canonical meals or another day", async () => {
    const canonical = await previewImport(store, "u", { sources: [{ conversation_id: "independent", messages: [{
      id: "meal", kind: "meal", display_name: "Canonical", calories: 10,
      timestamp: `${day}T12:00:00Z`, timezone: "Asia/Jerusalem"
    }] }] });
    await finish(String(canonical.job_id));
    await store.transact([write(pk, `DAY#${day}#ENTRY#manual`, "entry", entrySchema.parse({
      id: "manual", day_key: day, occurred_at: `${day}T12:00:00Z`, timezone: "Asia/Jerusalem",
      display_name: "Manual", calories: 25, calories_source: "user_number", match_stage: "manual",
      status: "active", created_at: `${day}T12:00:00Z`
    }))]);
    await finish(await prepared(browser("other-day", 10, [["Other day", 75]], nextDay), nextDay));
    const otherBefore = await allItems(store, pk, { prefix: `DAY#${nextDay}#` });
    const early = await prepared(browser("early", 10, [["Eggs", 100], ["Toast", 50]]));
    expect(await finish(early)).toMatchObject({ inserted: 3, failed: 0 });
    const independentBefore = (await allItems(store, pk, { prefix: `DAY#${day}#ENTRY#` }))
      .filter((r) => ["manual", digest(["independent", "meal"])].includes(String(r.data.id)));
    const later = await prepared(browser("later", 12, [["Toast", 80], ["Eggs", 100], ["Milk", 30]]));
    expect(await finish(later)).toMatchObject({ inserted: 4, failed: 0 });
    expect((await active()).map((r) => [r.display_name, r.calories]).sort()).toEqual(
      [["Canonical", 10], ["Eggs", 100], ["Manual", 25], ["Milk", 30], ["Toast", 80]].sort()
    );
    const entries = await allItems(store, pk, { prefix: `DAY#${day}#ENTRY#` });
    expect(entries.filter((r) => r.data.status === "superseded")).toHaveLength(2);
    expect(entries.filter((r) => independentBefore.some((old) => old.SK === r.SK))).toEqual(independentBefore);
    expect(await allItems(store, pk, { prefix: `DAY#${nextDay}#` })).toEqual(otherBefore);
    expect(await active(nextDay)).toHaveLength(1);
  });

  it("preserves legitimate identical meal rows and changes row counts/order without stale active entries", async () => {
    const first = browser("one", 10, [["Eggs", 100], ["Eggs", 100], ["Toast", 50]]);
    expect(await finish(await prepared(first))).toMatchObject({ inserted: 4 });
    expect(await active()).toHaveLength(3);
    const second = browser("two", 12, [["Toast", 60], ["Eggs", 100], ["Eggs", 100], ["Milk", 20]]);
    expect(await finish(await prepared(second))).toMatchObject({ inserted: 5, reconciliation: [{ matches: true, ledger_total: 280 }] });
    expect((await active()).filter((e) => e.display_name === "Eggs")).toHaveLength(2);
    expect(await finish(await prepared(browser("three", 14, [["Eggs", 100], ["Eggs", 100]])))).toMatchObject({
      inserted: 3, reconciliation: [{ matches: true, ledger_total: 200 }]
    });
    expect(await active()).toHaveLength(2);
    const entries = await allItems(store, pk, { prefix: `DAY#${day}#ENTRY#` });
    expect(entries.filter((r) => r.data.status === "superseded")).toHaveLength(7);
  });

  it("reimports exact revisions as duplicates and never reverts to an older overlapping export", async () => {
    const earlier = browser("early", 10, [["Eggs", 100]]);
    const later = browser("late", 12, [["Eggs", 100], ["Toast", 50]]);
    await finish(await prepared(later));
    const before = await allItems(store, pk, { prefix: `DAY#${day}#` });
    expect(await finish(await prepared(later))).toMatchObject({ duplicate: 3, inserted: 0, failed: 0 });
    expect(await finish(await prepared(earlier))).toMatchObject({ duplicate: 2, inserted: 0, failed: 0 });
    expect(await finish(await prepared(earlier))).toMatchObject({ duplicate: 2, inserted: 0, failed: 0 });
    expect(await allItems(store, pk, { prefix: `DAY#${day}#` })).toEqual(before);
    const receipts = await allItems(store, pk, { prefix: "SOURCE#BROWSER_TABLE#" });
    expect(receipts).toHaveLength(2);
    expect(receipts.find((r) => r.data.status === "duplicate")?.data.sources).toHaveLength(2);
  });

  it("requires review of every row and summary and rejects splitting a table over multiple days", async () => {
    const preview = await previewImport(store, "u", browser("review", 10, [["Eggs", 100], ["Toast", 50]]));
    const rows = preview.records as RecordRow[], id = String(preview.job_id);
    await reviewImport(store, "u", id, { resolutions: [{ source_id: rows[0]!.source_id, action: "include" }] });
    await expect(confirmImport(store, "u", id)).rejects.toThrow(/Review/);
    expect(await active()).toHaveLength(0);
    await reviewImport(store, "u", id, {
      resolutions: rows.slice(1).map((r) => ({ source_id: r.source_id, action: "include", day: nextDay }))
    });
    expect(await finish(id)).toMatchObject({ failed: 3, inserted: 0 });
    expect(await allItems(store, pk, { prefix: "SOURCE#BROWSER_TABLE#" })).toHaveLength(0);
  });

  it("rejects source receipt replay with a different assigned day or changed same-revision content", async () => {
    const body = browser("original", 10, [["Eggs", 100]]);
    await finish(await prepared(body));
    const before = await allItems(store, pk, { prefix: `DAY#${day}#` });
    expect(await finish(await prepared(body, nextDay))).toMatchObject({ failed: 2, inserted: 0 });
    expect(await finish(await prepared(browser("original", 10, [["Eggs", 999]])))).toMatchObject({ failed: 2, inserted: 0 });
    expect((await allItems(store, pk, { prefix: `DAY#${day}#` })).filter((r) => r.entity === "entry"))
      .toEqual(before.filter((r) => r.entity === "entry"));
    expect((await history(store, "u", day, day))[0]?.completeness).toBe("partial");
    expect(await active(nextDay)).toHaveLength(0);
  });

  it("does not replay an immutable source revision onto another day after the profile timezone changes", async () => {
    const body = browser("midnight", 23, [["Eggs", 100]]);
    await finish(await prepared(body, nextDay));
    const oldProfile = (await store.get(pk, "PROFILE"))!;
    await store.transact([write(pk, "PROFILE", "profile", { ...oldProfile.data, timezone: "UTC" }, oldProfile)]);
    expect(await finish(await prepared(body))).toMatchObject({ failed: 2, inserted: 0 });
    expect(await active()).toHaveLength(0);
    expect(await active(nextDay)).toHaveLength(1);
    expect(await allItems(store, pk, { prefix: "SOURCE#BROWSER_TABLE#" })).toHaveLength(1);
  });

  it("requires actual source timestamps and handles Unix epoch zero without falling back to today", async () => {
    const missing = { sources: [{ id: "c", messages: [{ id: "m", role: "assistant", content: "| Eggs | 100 |" }] }] };
    await expect(previewImport(store, "u", missing)).rejects.toThrow(/source timestamp/);
    await expect(previewImport(store, "u", browser("invalid", 10, [["Eggs", 100]], "2025-02-30"))).rejects.toThrow(/invalid/);
    const epoch = normalizeBrowserSources({ sources: [{ id: "c", messages: [{
      id: "epoch", role: "assistant", create_time: 0, content: "| Eggs | 100 |"
    }] }] }, "UTC") as { sources: Array<{ messages: Array<{ timestamp: string }> }> };
    expect(epoch.sources[0]!.messages[0]!.timestamp).toBe("1970-01-01T00:00:00.000Z");
  });

  it.each(["before", "after"] as const)("resumes a crash %s the atomic revision transaction without partial replacement or receipts", async (when) => {
    await finish(await prepared(browser("early", 10, [["Eggs", 100]])));
    const id = await prepared(browser("late", 12, [["Eggs", 100], ["Toast", 50]]));
    const transact = store.transact.bind(store);
    let crashed = false;
    vi.spyOn(store, "transact").mockImplementation(async (writes) => {
      if (!crashed && isRevision(writes)) {
        crashed = true;
        if (when === "after") await transact(writes);
        throw new Error("Simulated process interruption");
      }
      await transact(writes);
    });
    await expect(confirmImport(store, "u", id)).rejects.toThrow(/interruption/);
    expect((await active()).map((e) => e.calories).sort()).toEqual(when === "before" ? [100] : [100, 50].sort());
    const receiptCount = (await allItems(store, pk, { prefix: "SOURCE#BROWSER_TABLE#" })).length;
    expect(receiptCount).toBe(when === "before" ? 1 : 2);
    expect(await finish(id)).toMatchObject({ inserted: 3, failed: 0 });
    expect(await active()).toHaveLength(2);
    expect(await finish(await prepared(browser("late", 12, [["Eggs", 100], ["Toast", 50]])))).toMatchObject({ duplicate: 3 });
  });

  it("serializes concurrent same-revision imports using group versions and durable source receipts", async () => {
    const body = browser("race", 12, [["Eggs", 100], ["Eggs", 100]]);
    const a = await prepared(body), b = await prepared(body);
    const reports = await Promise.all([finish(a), finish(b)]);
    expect(reports.map((r) => r.inserted).sort()).toEqual([0, 3]);
    expect(reports.map((r) => r.duplicate).sort()).toEqual([0, 3]);
    expect(reports.every((r) => r.failed === 0)).toBe(true);
    expect(await active()).toHaveLength(2);
    expect(await allItems(store, pk, { prefix: "SOURCE#BROWSER_TABLE#" })).toHaveLength(1);
    expect(await allItems(store, pk, { prefix: "BROWSER_TABLE#" })).toHaveLength(1);
  });

  it("rebuilds after a losing revision race and never lets the older table win", async () => {
    const older = await prepared(browser("old", 10, [["Old", 100]]));
    const newer = await prepared(browser("new", 12, [["New", 200]]));
    const transact = store.transact.bind(store);
    let interleaved = false;
    vi.spyOn(store, "transact").mockImplementation(async (writes) => {
      if (!interleaved && isRevision(writes)) {
        interleaved = true;
        await finish(newer);
        throw new StoreConflict("A newer revision committed first");
      }
      await transact(writes);
    });
    expect(await finish(older)).toMatchObject({ duplicate: 2, failed: 0, inserted: 0 });
    expect((await active()).map((e) => e.display_name)).toEqual(["New"]);
    const group = (await allItems(store, pk, { prefix: "BROWSER_TABLE#" }))[0]!;
    expect(group.version).toBe(2);
  });

  it("keeps 30-row replacement groups within 100 transaction items", async () => {
    const foods: Food[] = Array.from({ length: 29 }, (_, i) => [`Meal ${i}`, i + 1]);
    await finish(await prepared(browser("many-old", 10, foods)));
    const sizes: number[] = [], transact = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementation(async (writes) => {
      sizes.push(writes.length);
      await transact(writes);
    });
    expect(await finish(await prepared(browser("many-new", 12, [...foods].reverse())))).toMatchObject({ inserted: 30, failed: 0 });
    expect(Math.max(...sizes)).toBe(91);
    expect(await active()).toHaveLength(29);
  });
});
