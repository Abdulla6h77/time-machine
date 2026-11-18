import { chromium } from "playwright-core";
import { publicUrl } from "./public-url.mjs";
import { tiny } from "./provider.mjs";

const base = "https://api.browser.tinyfish.ai";

async function captureInSession(target, direct) {
  const session = await tiny("", {
    base, method: "POST",
    data: { timeout_seconds: 90, ...(direct ? { proxy_config: { enabled: false } } : {}) },
  });
  let browser;
  try {
    if (!session.session_id || new URL(session.cdp_url).protocol !== "wss:") {
      throw new Error("Unexpected TinyFish Browser session response");
    }
    browser = await chromium.connectOverCDP(session.cdp_url, { timeout: 20_000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.newPage();
    const hosts = new Map([[target.origin, Promise.resolve(target)]]);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await page.routeWebSocket("**/*", route => route.close());
    // CDP pauses individual requests, including each redirect destination.
    cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
      try {
        const destination = new URL(request.url);
        if (!["GET", "HEAD"].includes(request.method) || destination.username || destination.password) {
          throw new Error("Restricted browser request");
        }
        if (!hosts.has(destination.origin)) hosts.set(destination.origin, publicUrl(destination.origin));
        await hosts.get(destination.origin);
        await cdp.send("Fetch.continueRequest", { requestId });
      } catch {
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
      }
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (!response?.ok()) throw new Error(`Browser navigation HTTP ${response?.status() ?? "unknown"}`);
    const rendered = await publicUrl(page.url());
    if (target.origin !== rendered.origin) throw new Error("Browser source changed origin after Monitor observed it");
    const screenshot = await page.screenshot({ type: "jpeg", quality: 77, timeout: 15_000 });
    return { screenshot, capturedAt: new Date().toISOString() };
  } finally {
    await browser?.close().catch(() => {});
    if (session.session_id) {
      await tiny("/" + encodeURIComponent(session.session_id), { base, method: "DELETE", timeout: 15_000 })
        .catch(error => console.error("Browser termination unconfirmed:", error.message));
    }
  }
}

export async function capture(url) {
  const target = await publicUrl(url);
  try {
    return await captureInSession(target, false);
  } catch (error) {
    if (!error.message.includes("ERR_TUNNEL_CONNECTION_FAILED")) throw error;
    return captureInSession(target, true);
  }
}
