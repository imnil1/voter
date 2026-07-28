const { chromium } = require("playwright-core");
const { log } = require("./logging");

// Overridable via env var so keeping the UA's claimed Chrome version in
// sync with browserless-v2's actual Chromium build doesn't require a code
// change/redeploy — just a Railway env var update.
const SPOOFED_USER_AGENT = process.env.SPOOFED_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Applies the same viewport + UA setup to any page — used for both the
// initial auth page and any additional pages, so every tab gets identical,
// correctly-sized rendering and consistent fingerprinting.
async function preparePage(page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ "User-Agent": SPOOFED_USER_AGENT });
  return page;
}

async function connectBrowser() {
  const baseWsEndpoint = process.env.BROWSER_WS_URL;
  if (!baseWsEndpoint) throw new Error("BROWSER_WS_URL is not set");

  // browserless v2 can render in an undersized frame regardless of any
  // post-connect page.setViewportSize() call. Browserless staff recommend
  // combining both defaultViewport (page-level) and --window-size (actual
  // Chrome window) in the same launch param for reliability.
  // See: https://github.com/browserless/browserless/discussions/3910
  const launchParams = JSON.stringify({
    defaultViewport: { width: 1920, height: 1080 },
    args: ["--window-size=1920,1080"],
  });
  const separator = baseWsEndpoint.includes("?") ? "&" : "?";
  const wsEndpoint = `${baseWsEndpoint}${separator}launch=${encodeURIComponent(launchParams)}`;

  log(`[browser] Connecting via Playwright (CDP)...`);
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await preparePage(page);
  const actualViewport = page.viewportSize();
  log(`[browser] Viewport set to ${actualViewport?.width}x${actualViewport?.height}`);
  return { browser, context, page };
}

module.exports = { preparePage, connectBrowser };
