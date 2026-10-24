import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { normalizeFoodText } from "./seed.js";
import type { FoodRecord } from "./types.js";
import type { ParsedMessage } from "./llm.js";

export type ResolvedItem = {
  id: string;
  foodId: string | null;
  raw: string;
  name: string;
  quantity: number | null;
  unit: string;
  calories: number;
  caloriesSource: "db" | "user_number" | "estimate";
  matchStage: string;
  supersedesEntryId: string | null;
};

type FoodRow = {
  id: string;
  name: string;
  category: string;
  basis_json: string;
  preferred_value_json: string | null;
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length]!;
}

function numericCalories(raw: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:k?cal(?:orie)?s?|קק"ל)/i.exec(raw);
  return match?.[1] ? Number(match[1]) : null;
}

function selectedCalories(row: FoodRow, quantity: number, unit: string): number | null {
  const basis = JSON.parse(row.basis_json) as Record<string, unknown>;
  const preferred = row.preferred_value_json ? JSON.parse(row.preferred_value_json) as Record<string, unknown> : {};
  const normalizedUnit = unit.toLocaleLowerCase("en");
  const secondary = Array.isArray(basis.secondary) ? basis.secondary as Array<{ unit?: unknown; calories?: unknown }> : [];
  const secondaryMatch = secondary.find((portion) =>
    typeof portion.unit === "string" && portion.unit.toLocaleLowerCase("en") === normalizedUnit &&
    typeof portion.calories === "number"
  );
  if (secondaryMatch && typeof secondaryMatch.calories === "number") {
    return Math.round(secondaryMatch.calories * quantity);
  }
  const portions = Array.isArray(basis.portions) ? basis.portions as Array<Record<string, unknown>> : [];
  const portion = portions[0];
  const per100 = preferred.calories_per_100g ?? basis.calories_per_100g;
  if (typeof per100 === "number") {
    if (normalizedUnit === "g") return Math.round(per100 * quantity / 100);
    if (normalizedUnit === "portion" && portion && typeof portion.grams === "number" &&
        typeof portion.calories === "number") return Math.round(per100 * portion.grams * quantity / 100);
    return null;
  }
  const per100ml = preferred.calories_per_100ml ?? basis.calories_per_100ml;
  if (typeof per100ml === "number") {
    if (normalizedUnit === "ml") return Math.round(per100ml * quantity / 100);
    if (normalizedUnit === "portion" && portion && typeof portion.ml === "number" &&
        typeof portion.calories === "number") return Math.round(per100ml * portion.ml * quantity / 100);
    return null;
  }
  const perGram = preferred.calories_per_gram ?? basis.calories_per_gram;
  if (typeof perGram === "number") {
    return normalizedUnit === "g" ? Math.round(perGram * quantity) : null;
  }
  const calories = typeof preferred.calories === "number" ? preferred.calories : basis.calories;
  if (typeof calories === "number") {
    const portionGrams = typeof basis.portion_grams === "number" ? basis.portion_grams : null;
    if (portionGrams && normalizedUnit === "g") return Math.round(calories * quantity / portionGrams);
    if (normalizedUnit === "g" || normalizedUnit === "ml") return null;
    return Math.round(calories * quantity);
  }
  const perUnit = typeof basis.calories_per_unit === "number" ? basis.calories_per_unit : null;
  if (perUnit !== null) return normalizedUnit === "g" || normalizedUnit === "ml" ? null : Math.round(perUnit * quantity);
  return null;
}

function bestFood(rows: FoodRow[], aliases: Array<{ food_id: string; normalized_alias: string }>, raw: string, suggestedId: string | null): { row: FoodRow; stage: string } | null {
  void suggestedId;
  const normalized = normalizeFoodText(raw.replace(/\d+(?:\.\d+)?\s*(?:g|ml|calories?|קק\"ל)\b/gi, ""));
  const exact = rows.find((row) => normalizeFoodText(row.name) === normalized);
  if (exact) return { row: exact, stage: "exact" };
  const matches = new Set(aliases
    .filter((item) => item.normalized_alias === normalized || normalized.includes(item.normalized_alias))
    .map((item) => item.food_id));
  if (matches.size === 1) {
    const row = rows.find((candidate) => candidate.id === matches.values().next().value);
    if (row) return { row, stage: "alias" };
  }
  if (matches.size > 1) return null;
  const ranked = rows.map((row) => {
    const aliasStrings = aliases.filter((alias) => alias.food_id === row.id).map((alias) => alias.normalized_alias);
    const score = Math.min(distance(normalized, normalizeFoodText(row.name)), ...aliasStrings.map((alias) => distance(normalized, alias)));
    return { row, score };
  }).sort((a, b) => a.score - b.score);
  const first = ranked[0];
  if (first && first.score <= Math.max(2, Math.floor(normalized.length * 0.18)) &&
      (!ranked[1] || ranked[1].score > first.score)) return { row: first.row, stage: "fuzzy" };
  return null;
}

function recentEntry(db: Database.Database, userId: string, raw: string): { row: FoodRow; name: string; calories: number; quantity: number; unit: string } | null {
  const entry = db.prepare(`
    SELECT food_id, display_name, calories, quantity, unit FROM log_entries
    WHERE user_id = ? AND status = 'active' AND food_id IS NOT NULL
    ORDER BY occurred_at DESC LIMIT 1
  `).get(userId) as { food_id: string; display_name: string; calories: number; quantity: number | null; unit: string } | undefined;
  if (!entry || !/(same as yesterday|usual|another one)/i.test(raw)) return null;
  const row = db.prepare("SELECT * FROM foods WHERE id = ?").get(entry.food_id) as FoodRow | undefined;
  return row ? { row, name: entry.display_name, calories: entry.calories, quantity: entry.quantity ?? 1, unit: entry.unit } : null;
}

export function resolveItems(db: Database.Database, userId: string, parsed: ParsedMessage): ResolvedItem[] {
  const recent = recentEntry(db, userId, "the usual");
  return resolveCatalog(foodRecords(db), parsed, recent ? {
    foodId: recent.row.id, name: recent.name, calories: recent.calories,
    quantity: recent.quantity, unit: recent.unit
  } : null);
}

export function resolveCatalog(
  foods: FoodRecord[], parsed: ParsedMessage,
  recent: { foodId: string; name: string; calories: number; quantity: number; unit: string } | null = null
): ResolvedItem[] {
  const rows: FoodRow[] = foods.map((f) => ({ id: f.id, name: f.name, category: f.category, basis_json: JSON.stringify(f.basis), preferred_value_json: f.preferred_value ? JSON.stringify(f.preferred_value) : null }));
  const aliases = foods.flatMap((f) => f.aliases.map((a) => ({ food_id: f.id, normalized_alias: normalizeFoodText(a) })));
  return parsed.items.map((item) => {
    const stated = numericCalories(item.raw);
    if (stated !== null) return {
      id: randomUUID(), foodId: null, raw: item.raw, name: item.display_name || item.raw,
      quantity: item.quantity, unit: item.unit, calories: stated, caloriesSource: "user_number",
      matchStage: "user_number", supersedesEntryId: item.supersedes_entry_id
    };
    if (item.match_stage === "recent_log") {
      if (recent && /(same as yesterday|usual|another one)/i.test(item.raw)) return {
        id: randomUUID(), foodId: recent.foodId, raw: item.raw, name: recent.name,
        quantity: recent.quantity, unit: recent.unit, calories: recent.calories,
        caloriesSource: "db", matchStage: "recent_log", supersedesEntryId: item.supersedes_entry_id
      };
      return {
        id: randomUUID(), foodId: null, raw: item.raw, name: item.display_name || item.raw,
        quantity: item.quantity, unit: item.unit, calories: 0, caloriesSource: "estimate",
        matchStage: "unresolved", supersedesEntryId: null
      };
    }
    const normalized = normalizeFoodText(item.raw.replace(/\d+(?:\.\d+)?\s*(?:g|ml|calories?|קק\"ל)\b/gi, ""));
    const ambiguous = new Set(aliases.filter((a) => a.normalized_alias === normalized || normalized.includes(a.normalized_alias)).map((a) => a.food_id)).size > 1;
    const match = bestFood(rows, aliases, item.raw, item.food_key);
    if (match) {
      const basis = JSON.parse(match.row.basis_json) as Record<string, unknown>;
      const missingQuantityUnit = typeof basis.calories_per_100g === "number"
        ? "g"
        : typeof basis.calories_per_100ml === "number" ? "ml" : "g";
      const defaultQuantity = typeof basis.calories_per_gram === "number"
        ? 1
        : typeof basis.calories_per_100g === "number" || typeof basis.calories_per_100ml === "number" ? 100 : 1;
      const quantity = item.quantity ?? defaultQuantity;
      const unit = item.quantity === null && (
        typeof basis.calories_per_100g === "number" || typeof basis.calories_per_100ml === "number" ||
        typeof basis.calories_per_gram === "number"
      ) ? missingQuantityUnit : item.unit;
      const calories = selectedCalories(match.row, quantity, unit);
      if (calories === null) return {
        id: randomUUID(), foodId: match.row.id, raw: item.raw,
        name: item.display_name || match.row.name, quantity, unit, calories: 0,
        caloriesSource: "db", matchStage: "unresolved", supersedesEntryId: item.supersedes_entry_id
      };
      return {
        id: randomUUID(), foodId: match.row.id, raw: item.raw,
        name: item.display_name || match.row.name, quantity, unit,
        calories,
        caloriesSource: "db", matchStage: match.stage, supersedesEntryId: item.supersedes_entry_id
      };
    }
    if (!ambiguous && item.calories_source === "estimate" && item.calories !== null) return {
      id: randomUUID(), foodId: null, raw: item.raw, name: item.display_name,
      quantity: item.quantity, unit: item.unit, calories: item.calories,
      caloriesSource: "estimate", matchStage: "estimate", supersedesEntryId: item.supersedes_entry_id
    };
    return {
      id: randomUUID(), foodId: null, raw: item.raw, name: item.display_name || item.raw,
      quantity: item.quantity, unit: item.unit, calories: 0,
      caloriesSource: "estimate", matchStage: "unresolved", supersedesEntryId: item.supersedes_entry_id
    };
  });
}

export function foodRecords(db: Database.Database): FoodRecord[] {
  const rows = db.prepare("SELECT * FROM foods ORDER BY name").all() as FoodRow[];
  const aliases = db.prepare("SELECT food_id, alias FROM food_aliases ORDER BY alias").all() as Array<{ food_id: string; alias: string }>;
  return rows.map((row) => {
    const preferred = row.preferred_value_json ? JSON.parse(row.preferred_value_json) as Record<string, unknown> : undefined;
    return {
      id: row.id, name: row.name, aliases: aliases.filter((alias) => alias.food_id === row.id).map((alias) => alias.alias),
      category: row.category, basis: JSON.parse(row.basis_json) as Record<string, unknown>,
      ...(preferred ? { preferred_value: preferred } : {})
    };
  });
}
