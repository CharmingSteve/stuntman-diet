import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "./db.js";
import type { FoodRecord } from "./types.js";

type SeedFile = { foods: Array<FoodRecord & { source?: string }> };

export function normalizeFoodText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

export function seedFoods(db: ReturnType<typeof createDatabase>, foods: SeedFile["foods"]): void {
  const foodInsert = db.prepare(`
    INSERT INTO foods (id, name, category, basis_json, preferred_value_json, notes, source)
    VALUES (@id, @name, @category, @basis, @preferred, @notes, @source)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      basis_json = excluded.basis_json,
      notes = excluded.notes,
      source = excluded.source
  `);
  const aliasInsert = db.prepare(
    "INSERT OR IGNORE INTO food_aliases (food_id, alias, normalized_alias) VALUES (?, ?, ?)"
  );
  const transaction = db.transaction(() => {
    for (const food of foods) {
      foodInsert.run({
        id: food.id,
        name: food.name,
        category: food.category,
        basis: JSON.stringify(food.basis),
        preferred: food.preferred_value ? JSON.stringify(food.preferred_value) : null,
        notes: food.notes ?? null,
        source: food.source ?? "prompt_seed"
      });
      for (const alias of food.aliases) {
        aliasInsert.run(food.id, alias, normalizeFoodText(alias));
      }
      aliasInsert.run(food.id, food.name, normalizeFoodText(food.name));
    }
  });
  transaction();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const path = process.env.FOODS_PATH ?? "./seeds/foods.json";
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SeedFile;
  const db = createDatabase();
  try {
    seedFoods(db, parsed.foods);
    const { seedCatalog } = await import("./catalog.js");
    const { SQLiteStore } = await import("./store-sqlite.js");
    await seedCatalog(new SQLiteStore(db), parsed.foods);
  } finally { db.close(); }
}
