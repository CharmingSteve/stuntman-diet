import { StoreConflict, type Store } from "./store.js";
import { digest, write } from "./ledger.js";
import { normalizeFoodText } from "./seed.js";
import type { FoodRecord } from "./types.js";

export async function seedCatalog(store: Store, foods: FoodRecord[]): Promise<void> {
  for (const food of foods) {
    const previous = await store.get("CATALOG", `FOOD#${food.id}`);
    if (previous && digest(previous.data) === digest(food)) continue;
    const aliases = new Map(food.aliases.map((alias) => [normalizeFoodText(alias), alias]));
    const changes = [write("CATALOG", `FOOD#${food.id}`, "food", food, previous)];
    for (const [normalized, alias] of aliases) {
      const pk = `ALIAS#${normalized}`, sk = `FOOD#${food.id}`, old = await store.get(pk, sk);
      changes.push(write(pk, sk, "alias", { food_id: food.id, alias, normalized_alias: normalized, active: true }, old));
    }
    const oldAliases = previous && Array.isArray(previous.data.aliases) ? previous.data.aliases.filter((a): a is string => typeof a === "string") : [];
    for (const oldAlias of oldAliases) {
      const normalized = normalizeFoodText(oldAlias);
      if (aliases.has(normalized)) continue;
      const pk = `ALIAS#${normalized}`, sk = `FOOD#${food.id}`, old = await store.get(pk, sk);
      if (old) changes.push(write(pk, sk, "alias", { ...old.data, active: false }, old));
    }
    try { await store.transact(changes); }
    catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      const saved = await store.get("CATALOG", `FOOD#${food.id}`);
      if (!saved || digest(saved.data) !== digest(food)) throw error;
    }
  }
}
