import type Database from "better-sqlite3";
import { createDatabase } from "./db.js";
import {
  decodeCursor, encodeCursor, queryLimit, StoreConflict, validateWrites,
  type Store, type StoreItem, type StoreQuery, type StoreWrite
} from "./store.js";

type Row = Record<string, unknown>;
type ItemRow = { PK: string; SK: string; entity: string; version: number; data: string };
const MIGRATION = "legacy-sql-to-store-items-v1";

export class SQLiteStore implements Store {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? createDatabase();
    try { this.migrate(); }
    catch (error) {
      if (!db) this.db.close();
      throw error;
    }
  }

  async get(PK: string, SK: string): Promise<StoreItem | undefined> {
    const row = this.db.prepare("SELECT * FROM store_items WHERE PK = ? AND SK = ?")
      .get(PK, SK) as ItemRow | undefined;
    return row ? this.item(row) : undefined;
  }

  async query(PK: string, options: StoreQuery): Promise<{ items: StoreItem[]; cursor?: string }> {
    const limit = queryLimit(options);
    const cursor = decodeCursor(PK, options);
    const clauses = ["PK = ?"];
    const values: Array<string | number> = [PK];
    if (options.prefix !== undefined) {
      clauses.push("substr(SK, 1, length(?)) = ?");
      values.push(options.prefix, options.prefix);
    }
    if (options.from !== undefined) { clauses.push("SK >= ?"); values.push(options.from); }
    if (options.to !== undefined) { clauses.push("SK <= ?"); values.push(options.to); }
    if (cursor !== undefined) { clauses.push("SK > ?"); values.push(cursor); }
    values.push(limit + 1);
    const rows = this.db.prepare(
      `SELECT * FROM store_items WHERE ${clauses.join(" AND ")} ORDER BY SK COLLATE BINARY LIMIT ?`
    ).all(...values) as ItemRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.item(row)),
      ...(rows.length > limit && last ? { cursor: encodeCursor(PK, last.SK, options) } : {})
    };
  }

  async transact(writes: StoreWrite[]): Promise<void> {
    validateWrites(writes);
    const insert = this.db.prepare(
      "INSERT INTO store_items (PK, SK, entity, version, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(PK, SK) DO NOTHING"
    );
    const update = this.db.prepare(
      "UPDATE store_items SET entity = ?, version = ?, data = ? WHERE PK = ? AND SK = ? AND version = ?"
    );
    this.db.transaction(() => {
      for (const { item, expectedVersion } of writes) {
        const data = JSON.stringify(item.data);
        const result = expectedVersion === null
          ? insert.run(item.PK, item.SK, item.entity, item.version, data)
          : update.run(item.entity, item.version, data, item.PK, item.SK, expectedVersion);
        if (result.changes !== 1) throw new StoreConflict();
      }
    }).immediate();
  }

  close(): void { this.db.close(); }

  private item(row: ItemRow): StoreItem {
    return { PK: row.PK, SK: row.SK, entity: row.entity, version: row.version, data: JSON.parse(row.data) as Row };
  }

  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS store_items (
          PK TEXT NOT NULL, SK TEXT NOT NULL, entity TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY (PK, SK)
        );
        CREATE TABLE IF NOT EXISTS store_migrations (id TEXT PRIMARY KEY);
      `);
      if (this.db.prepare("SELECT id FROM store_migrations WHERE id = ?").get(MIGRATION)) return;
      const rows = (table: string): Row[] => {
        if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
        return this.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
      };
      const insert = this.db.prepare(
        "INSERT INTO store_items (PK, SK, entity, version, data) VALUES (?, ?, ?, 1, ?) ON CONFLICT(PK, SK) DO NOTHING"
      );
      const put = (PK: string, SK: string, entity: string, data: Row) =>
        insert.run(PK, SK, entity, JSON.stringify(data));
      const parse = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
      const profiles = rows("user_profiles");
      for (const profile of profiles) {
        put(`USER#${profile.user_id}`, "PROFILE", "profile", profile);
      }
      const entries = rows("log_entries");
      const metrics = rows("health_metrics");
      const legacyDays = rows("days");
      const users = new Set(
        [...profiles, ...legacyDays, ...entries, ...metrics, ...rows("turns")]
          .map((row) => row.user_id).filter((id): id is string => typeof id === "string")
      );
      const days = new Map<string, Row>();
      const dayId = (row: Row) => JSON.stringify([row.user_id, row.day_key]);
      for (const row of legacyDays) days.set(dayId(row), row);
      for (const row of [...entries, ...metrics]) {
        if (!days.has(dayId(row))) {
          days.set(dayId(row), {
            user_id: row.user_id, day_key: row.day_key, timezone: row.timezone,
            created_at: row.created_at ?? row.occurred_at, burn_total: null
          });
        }
      }
      const entryDays = new Set(entries.map(dayId));
      for (const day of days.values()) {
        const weekday = new Date(`${String(day.day_key)}T12:00:00Z`).getUTCDay();
        put(`USER#${day.user_id}`, `DAY#${day.day_key}#META`, "day", {
          day_key: day.day_key,
          timezone: day.timezone,
          burn_total: day.burn_total ?? null,
          burn_components: parse(day.burn_components_json) ?? [],
          burn_source: day.burn_total == null ? null : day.burn_source ?? "assumed",
          accept_default_burn: Boolean(day.accept_default_burn ?? false),
          eligibility: day.eligibility ?? (weekday === 5 || weekday === 6 ? "untracked" : "tracked"),
          completeness: day.completeness ?? (entryDays.has(dayId(day)) ? "partial" : "missing")
        });
      }
      for (const entry of entries) {
        put(`USER#${entry.user_id}`, `DAY#${entry.day_key}#ENTRY#${entry.id}`, "entry", entry);
      }
      for (const metric of metrics) {
        put(`USER#${metric.user_id}`, `DAY#${metric.day_key}#METRIC#${metric.id}`, "metric", metric);
      }
      const aliases = rows("food_aliases");
      for (const food of rows("foods")) {
        const { basis_json, preferred_value_json, notes } = food;
        put("CATALOG", `FOOD#${food.id}`, "food", {
          id: food.id, name: food.name, category: food.category,
          aliases: aliases.filter((alias) => alias.food_id === food.id).map((alias) => alias.alias),
          basis: parse(basis_json),
          ...(notes == null ? {} : { notes })
        });
        if (preferred_value_json != null) {
          const preference = parse(preferred_value_json);
          if (!preference || typeof preference !== "object" || Array.isArray(preference)) {
            throw new Error("Legacy food preference must be an object.");
          }
          // Legacy preferences were global. Preserve them only for users who
          // already owned legacy data, never as defaults for future users.
          for (const user of users) {
            put(`USER#${user}`, `FOOD_PREF#${food.id}`, "food_preference", preference as Row);
          }
        }
      }
      for (const alias of aliases) {
        put(`ALIAS#${alias.normalized_alias}`, `FOOD#${alias.food_id}`, "alias", alias);
      }
      this.db.prepare("INSERT INTO store_migrations (id) VALUES (?)").run(MIGRATION);
    }).immediate();
  }
}
