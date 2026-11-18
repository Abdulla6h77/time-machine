import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { capture } from "./capture.mjs";
import { acquireWorker, claimPoll, recoverAttempts } from "./collector-state.mjs";
import { drainRuns } from "./history.mjs";
import { monitorPath, time, tiny } from "./provider.mjs";
import { log, openStore, recordRun } from "./store.mjs";

export function queueRun(db, pageId, run, delivery) {
  const providerTime = time(run?.completed_at ?? run?.created_at, null);
  const received = new Date().toISOString();
  return recordRun(db, pageId, run, delivery, providerTime ?? received, providerTime ? "provider" : "receipt");
}

async function poll(db, page, interval) {
  const slot = claimPoll(db, page.id, Date.now(), interval);
  if (!slot) return;
  const finish = (status, run, message) => db.prepare(`UPDATE poll_attempts
    SET status=?,finished_at=?,run_id=?,message=? WHERE page_id=? AND scheduled_at=?`)
    .run(status, new Date().toISOString(), run ?? null, message ?? null, page.id, slot);
  try {
    let details;
    try {
      details = await tiny(monitorPath(page.id));
    } catch (error) {
      if (!/connection failed|HTTP (429|5\d\d)/i.test(error.message)) throw error;
      log(db, "poll_retry", { page: page.id, level: "warn", message: "Retrying read-only Monitor status after " + error.message });
      await sleep(10_000);
      details = await tiny(monitorPath(page.id));
      log(db, "poll_recovered", { page: page.id, message: "Read-only Monitor status retry succeeded" });
    }
    const checked = details.monitor ?? details;
    if (checked.id !== page.id || typeof checked.status !== "string") throw new Error("Unexpected Monitor status response");
    db.prepare("UPDATE pages SET status=?,confirmed_at=? WHERE id=?")
      .run(checked.status, new Date().toISOString(), page.id);
    if (checked.status !== "active") {
      finish("inactive", null, checked.status);
      log(db, "poll_inactive", { page: page.id, level: "warn", message: checked.status });
      return;
    }
    db.prepare("UPDATE poll_attempts SET status='dispatching' WHERE page_id=? AND scheduled_at=?").run(page.id, slot);
    const { run } = await tiny(monitorPath(page.id) + "/runs", { method: "POST" });
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = queueRun(db, page.id, run, "run-now");
      finish(inserted ? "received" : "duplicate", run.id);
      log(db, inserted ? "poll_received" : "poll_duplicate", { page: page.id, run: run.id });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const message = error.message.slice(0, 300);
    finish("failed", null, message);
    log(db, "poll_failed", { page: page.id, message, level: "warn" });
  }
}

export async function saveScreenshots(db, take = capture) {
  const pending = db.prepare(`SELECT id,page_id,source_url,observed_at,kind FROM versions
    WHERE kind <> 'noise' AND screenshot IS NULL AND screenshot_error IS NULL ORDER BY observed_at DESC LIMIT 4`).all();
  await Promise.all(pending.map(async version => {
    try {
      const age = Date.now() - Date.parse(version.observed_at);
      const allowedAge = version.kind === "baseline" ? 15 * 60_000 : 5 * 60_000;
      if (age > allowedAge) throw new Error("Capture window expired. A new screenshot would not represent this observation.");
      const { screenshot, capturedAt } = await take(version.source_url);
      if (!(screenshot instanceof Uint8Array) || screenshot[0] !== 255 || screenshot[1] !== 216 ||
        screenshot.length > 10_000_000 || !time(capturedAt, null)) throw new Error("Invalid JPEG capture");
      db.prepare("UPDATE versions SET screenshot=?,captured_at=? WHERE id=? AND page_id=? AND screenshot IS NULL")
        .run(screenshot, capturedAt, version.id, version.page_id);
      log(db, "screenshot_stored", { page: version.page_id, run: version.id });
    } catch (error) {
      const message = error.message.replace(/(?:wss?|https?):\/\/[^\s'"]+/g, "[url]").slice(0, 240);
      db.prepare("UPDATE versions SET screenshot_error=? WHERE id=?").run(message, version.id);
      log(db, "screenshot_failed", { page: version.page_id, run: version.id, message, level: "warn" });
    }
  }));
  return pending.length;
}

export async function runWorker() {
  const db = openStore();
  const hours = Number(process.env.TIME_MACHINE_RUN_NOW_HOURS ?? 0);
  const until = Date.parse(process.env.TIME_MACHINE_POLL_UNTIL ?? "");
  if (hours && (!Number.isFinite(until) || hours < 1 || hours > 24)) {
    throw new Error("Run-now requires a 1–24 hour interval and an explicit TIME_MACHINE_POLL_UNTIL timestamp");
  }
  const token = randomUUID();
  const now = Date.now();
  const previous = db.prepare("SELECT heartbeat_at,mode FROM worker_health WHERE id=1").get();
  if (!acquireWorker(db, token, now, hours, until)) {
    db.close();
    throw new Error("Another collector holds a fresh SQLite lease");
  }
  if (previous) {
    const gap = Math.round((now - Date.parse(previous.heartbeat_at)) / 1000);
    if (gap > 45 && previous.mode !== "stopped") {
      log(db, "worker_outage", { level: "warn", message: `Last heartbeat was ${gap}s before recovery` });
    }
    log(db, "worker_recovered", { message: "Collector resumed from the existing SQLite queue and poll schedule" });
  }
  recoverAttempts(db);
  let stopping = false;
  const heartbeat = setInterval(() => {
    const changed = db.prepare("UPDATE worker_health SET heartbeat_at=? WHERE id=1 AND token=?")
      .run(new Date().toISOString(), token).changes;
    if (!changed) stopping = true;
  }, 10_000);
  for (const event of ["SIGTERM", "SIGINT"]) process.on(event, () => { stopping = true; });
  log(db, "worker_started", { message: hours ? `Monitor run-now every ${hours}h until ${new Date(until).toISOString()}` : "Webhook ingestion" });
  try {
    while (!stopping) {
      drainRuns(db);
      if (await saveScreenshots(db)) continue;
      if (hours && Date.now() < until) {
        const due = db.prepare("SELECT * FROM pages WHERE status='active' AND next_poll_at<=? ORDER BY next_poll_at LIMIT 4")
          .all(new Date().toISOString());
        if (due.length) {
          await Promise.all(due.map(page => poll(db, page, hours * 3_600_000)));
          continue;
        }
      }
      await sleep(1500);
    }
  } finally {
    clearInterval(heartbeat);
    db.prepare("UPDATE worker_health SET mode='stopped',heartbeat_at=? WHERE id=1 AND token=?").run(new Date().toISOString(), token);
    log(db, "worker_stopped");
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch(error => { console.error(error.message); process.exitCode = 1; });
}
