const byId = id => document.getElementById(id);
const page = byId("page");
const timeline = byId("timeline");
const output = byId("query-output");
let pages = [];
let selection = 0;

async function request(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function element(tag, content) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

function link(text, href) {
  const anchor = element("a", text);
  anchor.href = href;
  anchor.rel = "noreferrer";
  anchor.target = "_blank";
  return anchor;
}

const when = stamp => new Date(stamp).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

page.addEventListener("change", async () => {
  const selected = ++selection;
  const id = page.value;
  timeline.replaceChildren();
  output.replaceChildren();
  byId("source").replaceChildren();
  const status = byId("timeline-status");
  status.textContent = id ? "Loading versions…" : "";
  if (!id) return;
  const record = pages.find(item => item.id === id);
  byId("source").append(link("Open live source", record.url));
  try {
    const { versions } = await request(`/api/pages/${id}/versions`);
    if (selected !== selection) return;
    status.textContent = versions.length ? `${versions.length} observed version(s)` : "No captured versions yet.";
    for (const version of versions) {
      const entry = element("li");
      entry.append(element("h3", version.title), element("p", `${version.kind} · ${when(version.observed_at)}`));
      entry.append(link("Source at this URL", version.source_url));
      if (version.screenshot_url) {
        const image = element("img");
        image.loading = "lazy";
        image.alt = `Screenshot of ${version.title}`;
        image.src = version.screenshot_url;
        const picture = link("", version.screenshot_url);
        picture.append(image);
        entry.append(element("p", "Screenshot taken " + when(version.captured_at)), picture);
      } else {
        entry.append(element("p", version.screenshot_error || "Screenshot queued."));
      }
      timeline.append(entry);
    }
  } catch (error) {
    if (selected === selection) status.textContent = error.message;
  }
});

for (const operation of ["as-of", "diff"]) {
  byId(operation).addEventListener("submit", async event => {
    event.preventDefault();
    if (!page.value) { output.textContent = "Choose a page first."; return; }
    const selected = selection;
    output.textContent = "Loading…";
    try {
      const query = new URLSearchParams(new FormData(event.currentTarget));
      const data = await request(`/api/pages/${page.value}/${operation}?${query}`);
      if (selected !== selection) return;
      if (operation === "as-of") {
        output.textContent = `Observed ${when(data.version.observed_at)}\n\n${data.version.content}`;
      } else {
        output.textContent = ["added", "removed", "changed"]
          .map(key => key.toUpperCase() + "\n" + (data[key].length ? JSON.stringify(data[key], null, 2) : "None")).join("\n\n");
      }
    } catch (error) {
      if (selected === selection) output.textContent = error.message;
    }
  });
}

try {
  const [data, status] = await Promise.all([request("/api/pages"), request("/api/status")]);
  pages = data.pages;
  for (const item of pages) {
    const option = element("option", `${item.name} · ${item.version_count} version(s)`);
    option.value = item.id;
    page.append(option);
  }
  byId("status").textContent = `${status.confirmed_active} confirmed active · ${status.genuine_changes} changes · ${status.screenshots_stored} screenshots`;
} catch (error) {
  byId("status").textContent = error.message;
}

const localTime = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" }) : "—";

async function refreshCollector() {
  const label = byId("collector");
  try {
    const { worker, pages: targets, last_check, next_check, recent } = await request("/api/collector");
    label.textContent = worker
      ? (worker.online ? "Collector online" : "Collector offline") + " · " + worker.mode
      : "No collector heartbeat recorded.";
    byId("collector-times").textContent = `Last received check ${localTime(last_check)} · Next local check ${localTime(next_check)} · Local times`;
    byId("collector-pages").replaceChildren(...targets.map(target => {
      const row = element("tr");
      const name = element("th");
      name.scope = "row";
      name.append(link(target.name, target.url));
      row.append(name, ...[localTime(target.last_check), localTime(target.next_check), target.checks, target.changes, target.failures]
        .map(value => element("td", value)));
      return row;
    }));
    const names = new Map(targets.map(target => [target.id, target.name]));
    byId("collector-events").replaceChildren(...(recent.length ? recent.map(entry =>
      element("li", `${localTime(entry.at)} · ${names.get(entry.page_id) ?? "Collector"} · ${entry.event.replaceAll("_", " ")}${entry.message ? ": " + entry.message : ""}`))
      : [element("li", "No recent collector events.")]));
  } catch (error) {
    label.textContent = "Monitoring status unavailable. " + error.message;
  }
}

void refreshCollector();
setInterval(refreshCollector, 30_000);
