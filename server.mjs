import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collectorStatus } from "./collector-state.mjs";
import { asOf, dateParam, diff } from "./history.mjs";
import { openStore, summary } from "./store.mjs";
import { queueRun } from "./worker.mjs";

const assets = new Map([
  ["/", ["text/html; charset=utf-8", "index.html"]],
  ["/timeline.js", ["text/javascript; charset=utf-8", "timeline.js"]],
  ["/style.css", ["text/css; charset=utf-8", "style.css"]],
]);
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (res, status, value) => res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));

function matches(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readWebhook(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Webhook payload exceeds 2 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function decorate(row) {
  if (!row) return null;
  return { ...row, screenshot_url: row.captured_at ? "/api/screenshots/" + encodeURIComponent(row.id) : null };
}

export function createApp(db, secret = process.env.TIME_MACHINE_WEBHOOK_SECRET) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const { pathname } = url;
      if (req.method === "POST" && pathname.startsWith("/hooks/monitor/")) {
        const token = pathname.slice("/hooks/monitor/".length);
        if (!matches(token, secret)) return json(res, 404, { error: "Not found" });
        let payload;
        try { payload = await readWebhook(req); }
        catch { return json(res, 400, { error: "Invalid webhook body" }); }
        if (!payload || typeof payload.id !== "string" || !/^[\w-]{1,100}$/.test(payload.id) ||
          typeof payload.fetch_monitor_id !== "string" || !Array.isArray(payload.results) ||
          !["baseline", "changed", "unchanged", null, undefined].includes(payload.outcome)) {
          return json(res, 400, { error: "Invalid Page Monitor result" });
        }
        const page = db.prepare("SELECT id FROM pages WHERE id=?").get(payload.fetch_monitor_id);
        if (!page) return json(res, 404, { error: "Unknown Monitor" });
        const inserted = queueRun(db, page.id, payload, "webhook");
        return json(res, 202, { accepted: true, duplicate: !inserted });
      }
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (assets.has(pathname)) {
        const [type, file] = assets.get(pathname);
        const body = readFileSync(new URL("./" + file, import.meta.url));
        return res.writeHead(200, { ...headers, "Content-Type": type }).end(body);
      }
      if (pathname === "/api/status" || pathname === "/health") return json(res, 200, summary(db));
      if (pathname === "/api/collector") return json(res, 200, collectorStatus(db));
      if (pathname === "/api/pages") {
        const rows = db.prepare(`SELECT p.id,p.name,p.url,p.status,p.created_at,p.confirmed_at,
          count(v.id) AS version_count,max(v.observed_at) AS latest_observation
          FROM pages p LEFT JOIN versions v ON p.id=v.page_id AND v.kind<>'noise' GROUP BY p.id ORDER BY p.name`).all();
        return json(res, 200, { pages: rows });
      }
      const screenshot = pathname.match(/^\/api\/screenshots\/([\w-]+)$/);
      if (screenshot) {
        const row = db.prepare("SELECT screenshot FROM versions WHERE kind<>'noise' AND id=?").get(screenshot[1]);
        if (!row?.screenshot) return json(res, 404, { error: "Screenshot unavailable" });
        return res.writeHead(200, { ...headers, "Content-Type": "image/jpeg" }).end(Buffer.from(row.screenshot));
      }
      const route = pathname.match(/^\/api\/pages\/([\w-]+)\/(versions|as-of|diff)$/);
      if (!route) return json(res, 404, { error: "Not found" });
      const [, id, operation] = route;
      if (!db.prepare("SELECT id FROM pages WHERE id=?").get(id)) return json(res, 404, { error: "Unknown page" });
      if (operation === "versions") {
        const rows = db.prepare(`SELECT v.id,v.page_id,v.observed_at,v.source_url,v.title,v.kind,v.captured_at,
          v.screenshot_error,r.delivery,r.outcome,r.timestamp_source
          FROM versions v JOIN runs r ON r.id=v.id WHERE v.kind<>'noise' AND v.page_id=? ORDER BY v.observed_at DESC,v.id DESC`).all(id);
        return json(res, 200, { versions: rows.map(decorate) });
      }
      if (operation === "as-of") {
        const at = dateParam(url.searchParams.get("at"));
        if (!at) return json(res, 400, { error: "Use YYYY-MM-DD or an ISO timestamp with timezone" });
        const version = decorate(asOf(db, id, at));
        return version ? json(res, 200, { at, version }) : json(res, 404, { at, error: "No observation on or before this time" });
      }
      const from = dateParam(url.searchParams.get("from"));
      const to = dateParam(url.searchParams.get("to"));
      if (!from || !to || from > to) return json(res, 400, { error: "Provide valid dates in chronological order" });
      const oldVersion = asOf(db, id, from);
      const newVersion = asOf(db, id, to);
      if (!oldVersion || !newVersion) return json(res, 404, { error: "Both dates require an observed version" });
      return json(res, 200, {
        from_version: oldVersion.id, to_version: newVersion.id,
        ...diff(oldVersion.content, newVersion.content),
      });
    } catch (error) {
      console.error("Request failed:", error.code ?? error.name);
      if (!res.headersSent) json(res, 500, { error: "Request failed" });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openStore();
  const app = createApp(db);
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT ?? 3036);
  app.listen(port, host, () => console.log(`Time Machine listening at http://${host}:${app.address().port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.close(() => db.close()));
}
