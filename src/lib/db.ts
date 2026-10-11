import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "data/rizuu.db");

let db: Database;

export function getDb(): Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT UNIQUE NOT NULL,
      api_key_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      token_limit REAL,
      used_tokens REAL NOT NULL DEFAULT 0,
      rate_limit REAL,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      round_robin_providers INTEGER NOT NULL DEFAULT 0,
      is_follow_upstream INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS router_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      key TEXT UNIQUE NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS upstreams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      prefix TEXT,
      base_url TEXT,
      weight REAL NOT NULL DEFAULT 1,
      round_robin INTEGER NOT NULL DEFAULT 0,
      follow_upstream INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      quota_limit REAL,
      quota_baseline REAL NOT NULL DEFAULT 0,
      models TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS upstream_keys (
      id TEXT PRIMARY KEY,
      upstream_id TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      name TEXT,
      key TEXT NOT NULL,
      quota_limit REAL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migrate existing tables if missing new columns
  try { db.run("ALTER TABLE upstreams ADD COLUMN quota_limit REAL"); } catch (_) {}
  try { db.run("ALTER TABLE upstreams ADD COLUMN quota_baseline REAL NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN quota_limit REAL"); } catch (_) {}
  // Live quota columns (populated by intercepting provider quota-gate responses)
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_used REAL"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_total REAL"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_name TEXT"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_status TEXT"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_exp_date TEXT"); } catch (_) {}
  try { db.run("ALTER TABLE upstream_keys ADD COLUMN live_quota_checked_at TEXT"); } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id TEXT PRIMARY KEY,
      client_key_id TEXT,
      upstream_id TEXT,
      upstream_key_id TEXT,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      status INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  try { db.run("ALTER TABLE telemetry_logs ADD COLUMN upstream_key_id TEXT"); } catch (_) {}

  // Default settings
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insert.run("pin_hash", "");
  insert.run("cache_enabled", "false");
  insert.run("rtk_compression", "false");
  insert.run("caveman_mode", "false");
  insert.run("minify_prompt", "false");
  insert.run("cache_ttl_seconds", "300");
  insert.run("https_only", "false");
  insert.run("request_timeout_seconds", "60");
  insert.run("model_prefix_enabled", "false");
}
