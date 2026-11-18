import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { log, openStore } from "./store.mjs";

const directory = resolve(process.env.TIME_MACHINE_DATA_DIR ?? "state");
const config = JSON.parse(readFileSync(resolve(directory, "collector-config.json"), "utf8"));
const key = process.env.TINYFISH_API_KEY || (config.credentialFile
  && parseEnv(readFileSync(config.credentialFile, "utf8")).TINYFISH_API_KEY);
if (!key) throw new Error("Collector credential is unavailable");
const db = openStore(directory);
const fd = openSync(resolve(directory, "worker.log"), "a");
let child;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true;
  child?.kill();
});

try {
  let restarts = 0;
  while (!stopping) {
    const started = Date.now();
    child = spawn(process.execPath, ["worker.mjs"], {
      windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, TINYFISH_API_KEY: key, TIME_MACHINE_DATA_DIR: directory,
        TIME_MACHINE_RUN_NOW_HOURS: String(config.hours), TIME_MACHINE_POLL_UNTIL: config.until },
    });
    if (child.pid) writeFileSync(resolve(directory, "worker.pid"), String(child.pid));
    const watchdog = setInterval(() => {
      const heartbeat = db.prepare("SELECT pid,heartbeat_at FROM worker_health WHERE id=1").get();
      if (Date.now() - started > 150_000 &&
          (heartbeat?.pid !== child.pid || Date.now() - Date.parse(heartbeat.heartbeat_at) > 120_000)) {
        log(db, "worker_outage", { level: "warn", message: "Supervisor detected a stale worker heartbeat" });
        child.kill();
      }
    }, 15_000);
    const result = await new Promise(resolve => {
      child.once("error", error => resolve(error.code ?? "spawn error"));
      child.once("exit", (code, signal) => resolve(signal ?? code ?? "unknown"));
    });
    clearInterval(watchdog);
    if (child.pid) db.prepare("UPDATE worker_health SET mode='stopped' WHERE id=1 AND pid=?").run(child.pid);
    if (stopping) break;
    log(db, "worker_outage", { level: "warn", message: "Worker exited before supervisor shutdown" });
    if (Date.now() - started > 300_000) restarts = 0;
    const delay = Math.min(60, 5 * 2 ** Math.min(restarts++, 4));
    log(db, "supervisor_restart", { level: "warn", message: `Worker exited (${result}); restarting in ${delay}s` });
    await sleep(delay * 1000);
  }
} finally {
  closeSync(fd);
  db.close();
}
