import { log } from "./store.mjs";

const stamp = ms => new Date(ms).toISOString();

export function claimPoll(db, pageId, now, interval) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const page = db.prepare("SELECT next_poll_at FROM pages WHERE id=? AND status='active'").get(pageId);
    const due = Date.parse(page?.next_poll_at);
    if (!(due <= now)) {
      db.exec("COMMIT");
      return null;
    }
    const missed = Math.floor((now - due) / interval);
    const slot = stamp(due + missed * interval);
    db.prepare("UPDATE pages SET next_poll_at=? WHERE id=?").run(stamp(due + (missed + 1) * interval), pageId);
    db.prepare("INSERT INTO poll_attempts(page_id,scheduled_at,started_at,status) VALUES(?,?,?,'checking')")
      .run(pageId, slot, stamp(now));
    if (missed) log(db, "poll_missed", { page: pageId, level: "warn", message: `${missed} local slots missed since ${page.next_poll_at}; collecting the current slot only` });
    if (now - Date.parse(slot) > 120_000) log(db, "poll_late", { page: pageId, level: "warn", message: `Scheduled ${slot}; started ${stamp(now)}` });
    db.exec("COMMIT");
    return slot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recoverAttempts(db) {
  const attempts = db.prepare("SELECT page_id,scheduled_at,status FROM poll_attempts WHERE status IN ('checking','dispatching')").all();
  for (const row of attempts) {
    const message = row.status === "dispatching"
      ? "Worker stopped after dispatch intent; result unknown and POST will not be repeated"
      : "Worker stopped before dispatch; waiting for the next scheduled slot";
    db.prepare("UPDATE poll_attempts SET status='interrupted',finished_at=?,message=? WHERE page_id=? AND scheduled_at=?")
      .run(stamp(Date.now()), message, row.page_id, row.scheduled_at);
    log(db, "poll_interrupted", { page: row.page_id, level: "warn", message });
  }
}

export function acquireWorker(db, token, now, hours, until) {
  return db.prepare(`INSERT INTO worker_health(id,token,pid,started_at,heartbeat_at,mode,poll_until)
    VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    token=excluded.token,pid=excluded.pid,started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,
    mode=excluded.mode,poll_until=excluded.poll_until WHERE worker_health.heartbeat_at<=? OR worker_health.mode='stopped'`)
    .run(token, process.pid, stamp(now), stamp(now), hours ? "run-now" : "webhook",
      hours ? stamp(until) : null, stamp(now - 120_000)).changes === 1;
}

export function collectorStatus(db, now = Date.now()) {
  const worker = db.prepare("SELECT pid,started_at,heartbeat_at,mode,poll_until FROM worker_health WHERE id=1").get();
  const collecting = worker?.mode === "run-now" && now < Date.parse(worker.poll_until);
  const online = worker && worker.mode !== "stopped" && now - Date.parse(worker.heartbeat_at) < 120_000;
  const pages = db.prepare(`SELECT p.id,p.name,p.url,p.status,p.next_poll_at,
    (SELECT max(r.observed_at) FROM runs r WHERE r.page_id=p.id AND r.status<>'failed') AS last_check,
    (SELECT count(*) FROM runs r WHERE r.page_id=p.id AND r.status<>'failed') AS checks,
    (SELECT count(*) FROM versions v WHERE v.page_id=p.id AND v.kind='change') AS changes,
    (SELECT count(*) FROM logs l WHERE l.page_id=p.id AND l.event IN ('poll_failed','poll_interrupted','run_failed','screenshot_failed')) AS failures,
    (SELECT count(*) FROM versions v WHERE v.page_id=p.id AND v.screenshot_error IS NOT NULL) AS missing_captures
    FROM pages p ORDER BY p.name`).all().map(({ next_poll_at, ...page }) => ({
      ...page, next_check: collecting && page.status === "active" && next_poll_at < worker.poll_until ? next_poll_at : null,
    }));
  const next = pages.map(page => page.next_check).filter(Boolean).sort()[0] ?? null;
  const last = pages.map(page => page.last_check).filter(Boolean).sort().at(-1) ?? null;
  const recent = db.prepare(`SELECT at,event,page_id,message FROM logs WHERE event IN
    ('worker_outage','worker_recovered','supervisor_restart','poll_late','poll_missed','poll_interrupted','poll_retry','poll_failed','poll_recovered','screenshot_failed')
    ORDER BY id DESC LIMIT 15`).all();
  return { worker: worker ? { ...worker, online: Boolean(online) } : null,
    last_check: last, next_check: next, pages, recent };
}
