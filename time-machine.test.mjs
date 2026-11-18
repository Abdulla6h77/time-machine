import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { acquireWorker, claimPoll, collectorStatus, recoverAttempts } from "./collector-state.mjs";
import { asOf, dateParam, diff, drainRuns, normalize } from "./history.mjs";
import { webUrl } from "./public-url.mjs";
import { createApp } from "./server.mjs";
import { openStore, recordRun, summary } from "./store.mjs";
import { saveScreenshots } from "./worker.mjs";

const url = "https://example.com/";
const at = minute => `2026-11-11T12:${minute}:00.000Z`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "time-machine-test-"));
  const db = openStore(directory);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare("INSERT INTO pages VALUES (?,?,?,?,?,?,?,?)")
    .run("test-page", "Example", url, "active", at("00"), at("00"), at("00"), "0 0 * * *");
  return { db, directory };
}

function run(id, text, outcome) {
  return { id, outcome, is_baseline: outcome === "baseline", results: [{ url, title: "Pricing", text }] };
}

test("normalization drops tracker, ad and timestamp noise without losing prices or dated events", () => {
  const text = normalize("# Pricing\nCurrent time: 4:00\nAdvertisement\n[Plan](https://example.com/?utm_source=news&currency=USD)\n\nPro: $20\nMaintenance: November 11");
  assert.equal(text, "# Pricing\n[Plan](https://example.com/?currency=USD)\nPro: $20\nMaintenance: November 11");
  assert.equal(normalize("1 minute ago\nUpdated 2 hours ago\n$9"), "$9");
});

test("Google Cloud Status ignores its page clocks and keeps incident dates", () => {
  const status = "https://status.cloud.google.com/";
  const start = "Last updated time: 10 Nov 2026, 11:41 PST\nIncident detected November 10\n©2026 Google - Last updated: 2026-11-10 11:41:52 PST";
  const later = start.replaceAll("11:41", "11:47");
  assert.equal(normalize(start, status), "Incident detected November 10");
  assert.equal(normalize(later, status), normalize(start, status));
  assert.notEqual(normalize(later), normalize(start));
});
test("diff emits added, removed and changed blocks with their line positions", () => {
  const result = diff("Top\nPro: $20\nPlans\nEnterprise\nTerms\nFooter", "Top\nPro: $25\nPlans\nTerms\nNew clause\nFooter");
  assert.deepEqual(result.changed, [{ old_line: 2, new_line: 2, before: ["Pro: $20"], after: ["Pro: $25"] }]);
  assert.deepEqual(result.removed, [{ line: 4, lines: ["Enterprise"] }]);
  assert.deepEqual(result.added, [{ line: 5, lines: ["New clause"] }]);
  assert.deepEqual(diff("same", "same"), { added: [], removed: [], changed: [] });
});

test("durable queue deduplicates, preserves date boundaries and does not replace a newer version with a late run", t => {
  const { db, directory } = fixture(t);
  const first = run("r0", "Plan\n$20", "baseline");
  assert.equal(recordRun(db, "test-page", first, "fixture", at("00"), "provider"), true);
  assert.equal(recordRun(db, "test-page", first, "fixture", at("00"), "provider"), false);
  recordRun(db, "test-page", run("r1", "Plan\n$25", "changed"), "fixture", at("15"), "provider");
  const restarted = openStore(directory);
  try {
    drainRuns(restarted);
    recordRun(restarted, "test-page", run("noise", "Plan\nAdvertisement\n$25", "changed"), "fixture", at("16"), "provider");
    recordRun(restarted, "test-page", run("late", "Plan\n$23", "changed"), "fixture", at("10"), "provider");
    drainRuns(restarted);
    assert.equal(asOf(restarted, "test-page", "2026-11-10T00:00:00.000Z"), undefined);
    assert.equal(asOf(restarted, "test-page", at("09")).id, "r0");
    assert.match(asOf(restarted, "test-page", at("10")).screenshot_error, /out of order/);
    assert.equal(asOf(restarted, "test-page", at("15")).id, "r1");
    assert.equal(summary(restarted).genuine_changes, 2);
    assert.equal(restarted.prepare("SELECT status FROM runs WHERE id='noise'").get().status, "noise");
  } finally { restarted.close(); }
});

test("stores a valid capture and records a capture failure without inventing an image", async t => {
  const { db } = fixture(t);
  const observed = new Date().toISOString();
  recordRun(db, "test-page", run("shot", "Baseline", "baseline"), "fixture", observed, "provider");
  drainRuns(db);
  await saveScreenshots(db, async () => ({ screenshot: new Uint8Array([255,216,255,217]), capturedAt: observed }));
  assert.equal(summary(db).screenshots_stored, 1);
  recordRun(db, "test-page", run("fail", "Updated", "changed"), "fixture", observed, "provider");
  drainRuns(db);
  await saveScreenshots(db, async () => { throw new Error("Capture timeout"); });
  assert.equal(db.prepare("SELECT screenshot_error FROM versions WHERE id='fail'").get().screenshot_error, "Capture timeout");
  assert.equal(summary(db).screenshots_stored, 1);
});

test("HTTP interface rejects invalid dates and unauthorized webhooks and serves an observed version", async t => {
  const { db } = fixture(t);
  const app = createApp(db, "test-secret");
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = "http://127.0.0.1:" + app.address().port;
  const webhook = { ...run("r0", "Pricing", "baseline"), fetch_monitor_id: "test-page", created_at: at("00") };
  const post = token => fetch(base + "/hooks/monitor/" + token, { method: "POST", body: JSON.stringify(webhook) });
  assert.equal((await post("wrong")).status, 404);
  assert.equal((await (await post("test-secret")).json()).duplicate, false);
  assert.equal((await (await post("test-secret")).json()).duplicate, true);
  drainRuns(db);
  const uri = base + "/api/pages/test-page/as-of?at=";
  assert.equal((await fetch(uri + "2026-11-10")).status, 404);
  assert.equal((await fetch(uri + "2026-02-31")).status, 400);
  assert.equal((await (await fetch(uri + "2026-11-11")).json()).version.content, "Pricing");
  assert.equal((await fetch(base + "/")).status, 200);
  const collector = await (await fetch(base + "/api/collector")).json();
  assert.equal(collector.pages[0].checks, 1);
  assert.equal(collector.last_check, at("00"));
  assert.equal((await fetch(base + "/api/screenshots/r0")).status, 404);
});

test("public URL and date validation reject malformed or private inputs", () => {
  for (const input of ["file:///tmp", "http://127.1", "http://[::1]", "https://login@example.com/", "https://foo.local", "https://example.com:88/"]) {
    assert.throws(() => webUrl(input));
  }
  assert.equal(webUrl(url).href, url);
  assert.equal(dateParam("2026-11-11"), "2026-11-11T23:59:59.999Z");
  assert.equal(dateParam("2026-11-11T12:00:00+05:00"), "2026-11-11T07:00:00.000Z");
});

test("SQLite lease, interrupted dispatch and missed slots preserve one poll per scheduled slot", t => {
  const { db, directory } = fixture(t);
  const interval = 3_600_000;
  const now = Date.parse(at("00"));
  assert.equal(acquireWorker(db, "first", now, 1, now + 10 * interval), true);
  assert.equal(acquireWorker(db, "parallel", now, 1, now + 10 * interval), false);
  assert.equal(claimPoll(db, "test-page", now, interval), at("00"));
  db.prepare("UPDATE poll_attempts SET status='dispatching'").run();
  const restarted = openStore(directory);
  try {
    assert.equal(acquireWorker(restarted, "restart", now + 3 * interval, 1, now + 10 * interval), true);
    recoverAttempts(restarted);
    assert.equal(claimPoll(restarted, "test-page", now + 3 * interval, interval), "2026-11-11T15:00:00.000Z");
    assert.equal(claimPoll(db, "test-page", now + 3 * interval, interval), null);
    const ledger = db.prepare("SELECT status FROM poll_attempts ORDER BY scheduled_at").all();
    assert.deepEqual(ledger.map(row => row.status), ["interrupted", "checking"]);
    assert.match(db.prepare("SELECT message FROM logs WHERE event='poll_missed'").get().message, /^2 local slots/);
    assert.equal(collectorStatus(db, now + 3 * interval).next_check, "2026-11-11T16:00:00.000Z");
  } finally { restarted.close(); }
});

test("display-only relative clocks do not create a new version after a worker upgrade", t => {
  const { db } = fixture(t);
  recordRun(db, "test-page", run("old-clock", "Updated a few seconds ago\nNo incidents", "baseline"), "fixture", at("00"), "provider");
  drainRuns(db);
  db.prepare("UPDATE versions SET content=? WHERE id='old-clock'").run("Updated a few seconds ago\nNo incidents");
  recordRun(db, "test-page", run("new-clock", "Updated less than 1 minute ago\nNo incidents", "changed"), "fixture", at("15"), "provider");
  drainRuns(db);
  assert.equal(summary(db).genuine_changes, 0);
  assert.equal(db.prepare("SELECT status FROM runs WHERE id='new-clock'").get().status, "noise");
});
