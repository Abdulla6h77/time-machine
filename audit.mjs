import { createHash } from "node:crypto";
import { openStore } from "./store.mjs";

const db = openStore();
const rows = db.prepare(`SELECT v.id,v.page_id,v.source_url,v.kind,v.observed_at,v.captured_at,v.screenshot,
  r.page_id AS run_page_id,r.observed_at AS run_time,r.payload,p.url
  FROM versions v LEFT JOIN runs r ON r.id=v.id LEFT JOIN pages p ON p.id=v.page_id
  WHERE v.screenshot IS NOT NULL ORDER BY v.id`).all();
const failures = [];
const images = rows.map(row => {
  const payload = JSON.parse(row.payload ?? "null");
  const source = payload?.results?.find(result => result?.url === row.url);
  const lag = Date.parse(row.captured_at) - Date.parse(row.observed_at);
  let sourceMatches = false;
  try { sourceMatches = new URL(source?.final_url || source?.url).href === row.source_url; } catch {}
  const jpg = row.screenshot;
  if (payload?.id !== row.id || row.run_page_id !== row.page_id || row.observed_at !== row.run_time ||
      !sourceMatches || !Number.isFinite(lag) || lag < 0 ||
      jpg[0] !== 255 || jpg[1] !== 216 || jpg.at(-2) !== 255 || jpg.at(-1) !== 217) failures.push(row.id);
  return { id: row.id, kind: row.kind, lag_seconds: Math.round(lag / 1000),
    sha256: createHash("sha256").update(jpg).digest("hex") };
});
console.log(JSON.stringify({ checked: rows.length, failures, images }, null, 2));
db.close();
if (failures.length) process.exitCode = 1;
