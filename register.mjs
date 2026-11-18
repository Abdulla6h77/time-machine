import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { monitorPath, time, tiny } from "./provider.mjs";
import { log, openStore, recordRun, summary } from "./store.mjs";
import { publicUrl } from "./public-url.mjs";

const db = openStore();
const [url, name = url] = process.argv.slice(2);
const targets = url ? [{ url, name }] : JSON.parse(readFileSync(new URL("./targets.json", import.meta.url)));
const webhook = process.env.TIME_MACHINE_WEBHOOK_URL;
if (webhook && new URL(webhook).protocol !== "https:") throw new Error("Webhook must use HTTPS");
const { monitors } = await tiny("/v1/monitors");
if (!Array.isArray(monitors)) throw new Error("Unexpected TinyFish monitor list");
let failures = 0;

async function register(target, index) {
  try {
    const url = (await publicUrl(target.url)).href;
    const label = ("Time Machine: " + target.name).slice(0, 100);
    const existing = monitors.find(m => m.name === label && m.type === "fetch" && m.config?.url === url);
    const schedule = `${(index * 3) % 60} */6 * * *`;
    const created = existing ? { monitor: existing } : await tiny("/v1/monitors", {
      method: "POST",
      data: {
        type: "fetch", name: label, config: { url, format: "markdown" }, schedule_cron: schedule,
        purpose: "Meaningful updates to incident status, releases, policy, prices or published entries. Ignore rotating ads, navigation, relative clocks and tracking parameters.",
        ...(webhook ? { webhook_url: webhook } : {}),
      },
    });
    const m = created.monitor;
    if (!m?.id || m.type !== "fetch" || m.config?.url !== url) throw new Error("Unexpected Monitor create response");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO pages VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,confirmed_at=excluded.confirmed_at,schedule=excluded.schedule`)
      .run(m.id, target.name, url, m.status, time(m.created_at, null), now, now, m.schedule_cron ?? schedule);
    if (created.run) {
      const providerTime = time(created.run.created_at, null);
      recordRun(db, m.id, created.run, "create", providerTime ?? now, providerTime ? "provider" : "receipt");
    }
    const result = await tiny(monitorPath(m.id));
    const checked = result.monitor ?? result;
    if (checked.id !== m.id || typeof checked.status !== "string") throw new Error("Unexpected Monitor status response");
    db.prepare("UPDATE pages SET status=?,confirmed_at=? WHERE id=?").run(checked.status, new Date().toISOString(), m.id);
    const baseline = created.run ? (created.run.results?.some(r => typeof r.text === "string" && r.text.trim()) ? "available" : "missing") : "existing";
    log(db, "monitor_confirmed", { page: m.id, run: created.run?.id, message: checked.status + "; baseline " + baseline });
    if (checked.status !== "active") failures++;
    console.log(JSON.stringify({ name: target.name, id: m.id, status: checked.status, baseline }));
  } catch (error) {
    failures++;
    const message = String(error.message).slice(0, 240);
    log(db, "registration_failed", { level: "error", message: target.name + ": " + message });
    console.error(JSON.stringify({ name: target.name, error: message }));
  }
}

for (let index = 0; index < targets.length; index += 4) {
  await Promise.all(targets.slice(index, index + 4).map((target, offset) => register(target, index + offset)));
  if (index + 4 < targets.length) await sleep(300);
}
console.log(JSON.stringify(summary(db)));
db.close();
if (failures) process.exitCode = 1;
