import { createHash } from "node:crypto";
import { webUrl } from "./public-url.mjs";
import { log } from "./store.mjs";

export function normalize(text, source = "") {
  const googleStatus = /^https:\/\/status\.cloud\.google\.com\//i.test(source);
  return text.normalize("NFC").split(/\r?\n/).map(line => line.trim()
    .replace(/([?&])(?:utm_[\w-]+|gclid|fbclid)=[^&#\s)]+(?=&|#|\s|\)|$)/gi, "$1")
    .replace(/\?&+/g, "?").replace(/&{2,}/g, "&").replace(/[?&](?=[)#\s]|$)/g, "")
    .replace(/[\t ]+/g, " "))
    .filter(line => line && !/^(?:advertisement|sponsored (?:content|link)|skip to (?:main )?content)[.:\s]*$/i.test(line)
      && !(googleStatus && /^(?:last updated time:|©\d{4} google\s*[-–]\s*last updated:)/i.test(line))
      && !/^(?:page generated|page loaded|current time|checked at|all systems last checked)\s*[:–-]/i.test(line)
      && !/^(?:updated |posted )?(?:(?:less than )?(?:\d+|a few|a|an)\s+(?:seconds?|minutes?|hours?)) ago[.]?$/i.test(line))
    .join("\n");
}

export function processRun(db, run) {
  let status, message;
  const payload = JSON.parse(run.payload);
  const page = db.prepare("SELECT * FROM pages WHERE id=?").get(run.page_id);
  const result = Array.isArray(payload.results) && payload.results.find(item =>
    item?.url === page.url && typeof item.text === "string");
  let content, source;
  try {
    if (result) {
      source = webUrl(result.final_url || result.url).href;
      content = normalize(result.text, source);
    }
  } catch { /* The run remains recorded for diagnosis. */ }
  if (!content) {
    status = "failed";
    message = "Monitor supplied no usable content for the registered URL";
  } else {
    const hash = createHash("sha256").update(content).digest("hex");
    const latest = db.prepare(`SELECT hash, observed_at FROM versions WHERE kind<>'noise' AND page_id=?
      ORDER BY observed_at DESC, id DESC LIMIT 1`).get(page.id);
    const previous = db.prepare(`SELECT content,source_url FROM versions WHERE kind<>'noise' AND page_id=? AND observed_at <= ?
      ORDER BY observed_at DESC, id DESC LIMIT 1`).get(page.id, run.observed_at);
    const late = latest && run.observed_at < latest.observed_at;
    const reported = ["baseline", "changed", "unchanged"].includes(run.outcome);
    if (previous && normalize(previous.content, previous.source_url) === content) {
      status = run.outcome === "changed" ? "noise" : "unchanged";
    } else if (late && run.outcome !== "changed" && !payload.is_baseline && run.outcome !== "baseline") {
      status = "late";
      message = "Late run retained without enough evidence to attribute a change";
    } else {
      const kind = payload.is_baseline || run.outcome === "baseline" ? "baseline"
        : run.outcome === "changed" || (previous && !reported) ? "change"
        : previous ? "recovered" : "initial";
      db.prepare(`INSERT OR IGNORE INTO versions
        (id,page_id,observed_at,source_url,title,content,hash,kind,screenshot_error)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(run.id, page.id, run.observed_at, source, result.title || page.name,
          content, hash, kind, late ? "Run arrived out of order. A later screenshot would not represent this version." : null);
      status = kind;
    }
  }
  db.prepare("UPDATE runs SET status=?,message=? WHERE id=?").run(status, message ?? null, run.id);
  log(db, "run_" + status, { page: page.id, run: run.id, message, level: status === "failed" ? "warn" : "info" });
}

export function drainRuns(db) {
  const runs = db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY observed_at, received_at, id LIMIT 100").all();
  for (const run of runs) {
    db.exec("BEGIN IMMEDIATE");
    try {
      processRun(db, run);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function asOf(db, id, at) {
  return db.prepare(`SELECT id,page_id,observed_at,source_url,title,content,kind,captured_at,screenshot_error
    FROM versions WHERE kind<>'noise' AND page_id=? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(id, at);
}

export function dateParam(value) {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = new Date(value.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(+day) || day.toISOString().slice(0,10) !== value.slice(0,10)) return null;
  const date = new Date(dateOnly ? value + "T23:59:59.999Z" : value);
  return Number.isFinite(+date) ? date.toISOString() : null;
}

// Bounded line comparison. Unique common lines anchor ranges, preserving unchanged sections.
export function diff(oldText, newText) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const output = { added: [], removed: [], changed: [] };
  const positions = new Map();
  for (const [i, line] of newLines.entries()) positions.set(line, positions.has(line) ? -1 : i);
  let from = 0, to = 0;
  function addRange(endFrom, endTo) {
    const before = oldLines.slice(from, endFrom);
    const after = newLines.slice(to, endTo);
    if (before.length && after.length) output.changed.push({ old_line: from + 1, new_line: to + 1, before, after });
    else if (before.length) output.removed.push({ line: from + 1, lines: before });
    else if (after.length) output.added.push({ line: to + 1, lines: after });
  }
  while (from < oldLines.length && to < newLines.length) {
    if (oldLines[from] === newLines[to]) {
      from++;
      to++;
      continue;
    }
    let anchor = from;
    while (anchor < oldLines.length && (positions.get(oldLines[anchor]) ?? -1) < to) anchor++;
    if (anchor === oldLines.length) break;
    const destination = positions.get(oldLines[anchor]);
    addRange(anchor, destination);
    from = anchor + 1;
    to = destination + 1;
  }
  addRange(oldLines.length, newLines.length);
  return output;
}
