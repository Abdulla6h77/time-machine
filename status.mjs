import { openStore, summary } from "./store.mjs";
const db = openStore();
console.log(JSON.stringify({
  ...summary(db),
  pages: db.prepare("SELECT id,name,url,status,created_at,confirmed_at FROM pages ORDER BY created_at,id").all(),
  recent_logs: db.prepare("SELECT at,event,page_id,run_id,message FROM logs ORDER BY id DESC LIMIT 20").all(),
}, null, 2));
db.close();
