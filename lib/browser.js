const { chromium } = require("patchright-core");
const { log } = require("./logging");

// Overridable via env var so keeping the UA's claimed Chrome version in
// sync with browserless-v2's actual Chromium build doesn't require a code
// change/redeploy — just a Railway env var update.
const SPOOFED_USER_AGENT = process.env.SPOOFED_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Applies the same viewport + UA setup to any page — used for both the
// initial auth page and any additional pages, so every tab gets identical,
// correctly-sized rendering and consistent fingerprinting.
//
// Also attaches a network-request listener that captures Cloudflare
// Turnstile sitekeys as they're requested. This exists because the sitekey
// cannot be read from the DOM or from page.content() at all: Cloudflare
// renders the actual challenge iframe inside a CLOSED shadow root, and (per
// a real captured page source, confirmed empty of any sitekey-shaped
// string) top.gg's page HTML never contains the sitekey server-side either
// — the whole widget, sitekey included, is built by Cloudflare's own
// client-side script at runtime, only when its risk engine decides to show
// a challenge. But that script still has to make a real network request to
// fetch/render the frame — something like
// https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/.../0x4AAAAAAA-.../auto/...
// — and network requests aren't hidden by shadow DOM, only DOM queries are.
// Listening here catches it regardless of which page/reload it happens on,
// since the listener is attached once per page, not per Turnstile
// encounter.
const TURNSTILE_SITEKEY_PATTERN = /0x[0-9a-zA-Z_-]{20,24}/;

async function preparePage(page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ "User-Agent": SPOOFED_USER_AGENT });

  page._lastTurnstileSitekey = null;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("challenges.cloudflare.com")) {
      const match = url.match(TURNSTILE_SITEKEY_PATTERN);
      if (match) page._lastTurnstileSitekey = match[0];
    }
  });

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
  // --disable-blink-features=AutomationControlled avoids the
  // navigator.webdriver CDP tell — same flag patchright applies on a local
  // launch(), added manually here since browserless (not patchright) is
  // what actually launches the browser process in this architecture.
  const launchParams = JSON.stringify({
    defaultViewport: { width: 1920, height: 1080 },
    args: ["--window-size=1920,1080", "--disable-blink-features=AutomationControlled"],
  });
  const separator = baseWsEndpoint.includes("?") ? "&" : "?";
  const wsEndpoint = `${baseWsEndpoint}${separator}launch=${encodeURIComponent(launchParams)}`;

  log(`[browser] Connecting via Patchright (CDP)...`);
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await preparePage(page);
  const actualViewport = page.viewportSize();
  log(`[browser] Viewport set to ${actualViewport?.width}x${actualViewport?.height}`);
  return { browser, context, page };
}

module.exports = { preparePage, connectBrowser };
