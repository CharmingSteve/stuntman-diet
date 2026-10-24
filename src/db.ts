import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export function createDatabase(path = process.env.DB_PATH ?? "./data/diet.db"): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS foods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      basis_json TEXT NOT NULL,
      preferred_value_json TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'prompt_seed'
    );
    CREATE TABLE IF NOT EXISTS food_aliases (
      food_id TEXT NOT NULL REFERENCES foods(id),
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      PRIMARY KEY (food_id, normalized_alias)
    );
    CREATE INDEX IF NOT EXISTS food_aliases_normalized_idx ON food_aliases(normalized_alias);
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS days (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      burn_total REAL NOT NULL DEFAULT 2000,
      burn_components_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, day_key)
    );
    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      food_id TEXT REFERENCES foods(id),
      raw_text TEXT NOT NULL,
      display_name TEXT NOT NULL,
      quantity REAL,
      unit TEXT NOT NULL,
      calories REAL NOT NULL CHECK (calories >= 0),
      calories_source TEXT NOT NULL CHECK (calories_source IN ('db', 'user_number', 'estimate')),
      match_stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'void')),
      superseded_by TEXT REFERENCES log_entries(id),
      image_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS log_entries_user_day_idx ON log_entries(user_id, day_key, status);
    CREATE TABLE IF NOT EXISTS health_metrics (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      client_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      intent TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_user_date_idx ON turns(user_id, occurred_at);
  `);
  return db;
}
