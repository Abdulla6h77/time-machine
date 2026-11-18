import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openStore(directory = process.env.TIME_MACHINE_DATA_DIR ?? "state") {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, "history.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, created_at TEXT, confirmed_at TEXT NOT NULL,
      next_poll_at TEXT NOT NULL, schedule TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, timestamp_source TEXT NOT NULL,
      delivery TEXT NOT NULL, outcome TEXT, status TEXT NOT NULL DEFAULT 'queued',
      payload TEXT NOT NULL, message TEXT
    );
    CREATE INDEX IF NOT EXISTS run_queue ON runs(status, observed_at);
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY REFERENCES runs(id), page_id TEXT NOT NULL REFERENCES pages(id),
      observed_at TEXT NOT NULL, source_url TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, hash TEXT NOT NULL, kind TEXT NOT NULL,
      screenshot BLOB, captured_at TEXT, screenshot_error TEXT
    );
    CREATE INDEX IF NOT EXISTS version_history ON versions(page_id, observed_at, id);
    CREATE TABLE IF NOT EXISTS worker_health (
      id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL,
      started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, mode TEXT NOT NULL, poll_until TEXT
    );
    CREATE TABLE IF NOT EXISTS poll_attempts (
      page_id TEXT NOT NULL REFERENCES pages(id), scheduled_at TEXT NOT NULL, started_at TEXT NOT NULL,
      status TEXT NOT NULL, finished_at TEXT, run_id TEXT REFERENCES runs(id), message TEXT,
      PRIMARY KEY(page_id, scheduled_at)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL,
      page_id TEXT, run_id TEXT, message TEXT
    );
  `);
  return db;
}

export function log(db, event, { page, run, message, level = "info" } = {}) {
  db.prepare("INSERT INTO logs(at,level,event,page_id,run_id,message) VALUES (?,?,?,?,?,?)")
    .run(new Date().toISOString(), level, event, page ?? null, run ?? null, message ?? null);
}

export function recordRun(db, pageId, run, delivery, observedAt, timestampSource) {
  if (!run || typeof run.id !== "string" || !/^[\w-]{1,100}$/.test(run.id)) {
    throw new Error("TinyFish response is missing a valid run ID");
  }
  return db.prepare(`INSERT INTO runs(id,page_id,observed_at,received_at,timestamp_source,delivery,outcome,payload)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(run.id, pageId, observedAt, new Date().toISOString(), timestampSource, delivery,
      run.outcome ?? null, JSON.stringify(run)).changes > 0;
}

export function summary(db) {
  return db.prepare(`SELECT
    (SELECT count(*) FROM pages) AS registered_pages,
    (SELECT count(*) FROM pages WHERE status='active') AS confirmed_active,
    (SELECT min(coalesce(created_at,confirmed_at)) FROM pages WHERE status='active') AS earliest_monitoring_at,
    (SELECT count(*) FROM runs) AS provider_runs,
    (SELECT count(*) FROM versions WHERE kind <> 'noise' AND screenshot IS NOT NULL) AS screenshots_stored,
    (SELECT count(*) FROM versions WHERE kind='change') AS genuine_changes,
    (SELECT count(*) FROM versions WHERE kind='change' AND screenshot IS NOT NULL) AS changes_with_screenshots,
    (SELECT count(*) FROM runs WHERE status='failed') AS failed_runs,
    (SELECT count(*) FROM runs WHERE status='queued') AS queued_runs`).get();
}
