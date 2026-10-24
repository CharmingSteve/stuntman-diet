import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { seedCatalog } from "../src/catalog.js";
import { write, userPK } from "../src/ledger.js";
import { resolveCatalog } from "../src/resolver.js";
import type { FoodRecord } from "../src/types.js";
describe("editable catalog", () => {
  it("updates seeded fields and aliases without touching user preferences", async () => {
    const store = new SQLiteStore(createDatabase(":memory:"));
    try {
      const food: FoodRecord = { id: "food", name: "Old", aliases: ["old"], category: "test", basis: { calories: 100 } };
      await seedCatalog(store, [food]);
      await store.transact([write(userPK("u"), "FOOD_PREF#food", "food_preference", { calories: 200 })]);
      await seedCatalog(store, [{ ...food, name: "New", aliases: ["new"], basis: { calories: 300 } }]);
      expect((await store.get("CATALOG", "FOOD#food"))?.data).toMatchObject({ name: "New", basis: { calories: 300 }, aliases: ["new"] });
      expect((await store.get(userPK("u"), "FOOD_PREF#food"))?.data).toEqual({ calories: 200 });
      expect((await store.get("ALIAS#old", "FOOD#food"))?.data.active).toBe(false);
      expect((await store.get("ALIAS#new", "FOOD#food"))?.data.active).toBe(true);
    } finally { store.close(); }
  });
  it("uses corrected density for the same portion and gram quantities", () => {
    const foods = JSON.parse(readFileSync("seeds/foods.json", "utf8")).foods as FoodRecord[];
    const cottage = foods.find((f) => f.id === "cottage_9")!;
    const foodsWithPreference = [{ ...cottage, preferred_value: { calories_per_100g: 200 } }];
    const parsed = { intent: "food_log" as const, day_hint: null, burn: null, correction: null, question: null, needs_clarification: [], notes: "",
      items: [{ raw: "cottage 9", food_key: cottage.id, match_stage: "alias" as const, display_name: "Cottage cheese", quantity: 1, unit: "portion" as const, calories: null, calories_source: "db" as const, confidence: "high" as const, supersedes_entry_id: null }] };
    expect(resolveCatalog(foodsWithPreference, parsed)[0]?.calories).toBe(500);
    expect(resolveCatalog(foodsWithPreference, { ...parsed, items: [{ ...parsed.items[0]!, quantity: 250, unit: "g" }] })[0]?.calories).toBe(500);
  });
});
