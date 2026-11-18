const root = "https://agent.tinyfish.ai";

export async function tiny(path, { method = "GET", data, base = root, timeout = 90_000 } = {}) {
  const key = process.env.TINYFISH_API_KEY;
  if (!key) throw new Error("TINYFISH_API_KEY is required");
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`TinyFish connection failed: ${error.cause?.code ?? error.name}`);
  }
  if (response.status === 204) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const safe = value => typeof value === "string" && /^[\w.-]{1,100}$/.test(value) ? value : "-";
    throw new Error(`TinyFish HTTP ${response.status} (${safe(result?.error?.code)}, request ${safe(response.headers.get("x-request-id"))})`);
  }
  return result;
}

export const monitorPath = id => "/v1/monitors/" + encodeURIComponent(id);

export function time(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(" ", "T");
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : normalized + "Z";
  const date = new Date(utc);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : fallback;
}
