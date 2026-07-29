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
// Also captures Cloudflare Turnstile sitekeys via two independent methods,
// since neither alone is reliable against top.gg's actual embed:
//
// 1. Network-request listener (below) — catches the sitekey when it shows
//    up as a literal substring in a real HTTPS request URL to
//    challenges.cloudflare.com.
// 2. window.turnstile.render() interception (addInitScript, below) —
//    confirmed necessary via a captured Network tab showing every
//    challenges.cloudflare.com request as a `blob:` URL, not a real HTTPS
//    request, once the challenge is actually rendering. The `blob:` scheme
//    means the content is constructed locally by Cloudflare's own JS from
//    an object already in memory, not fetched over the network — so no
//    URL our request listener sees will ever contain the sitekey in that
//    case. The one real HTTPS request that does happen
//    (api.js?onload=...&render=explicit) confirms Cloudflare's script is
//    invoked in *explicit* render mode, where the caller passes the
//    sitekey as a plain JS object argument to `turnstile.render()` —
//    never serialized into any URL at all. Patching that function before
//    the page's own scripts run (via addInitScript, so this is in place
//    pre-navigation) is the only way to see that argument directly.
//
// Both methods write to the same page._lastTurnstileSitekey property;
// getTurnstileSitekey (turnstile.js) just reads whichever fired first.
const TURNSTILE_SITEKEY_PATTERN = /0x[0-9a-zA-Z_-]{20,24}/;

const TURNSTILE_RENDER_HOOK = `(() => {
  window._lastTurnstileSitekey = null;
  const install = () => {
    if (!window.turnstile || window.turnstile.__patched) return;
    const orig = window.turnstile.render;
    window.turnstile.render = function(container, params, ...rest) {
      try {
        if (params && params.sitekey) window._lastTurnstileSitekey = params.sitekey;
      } catch (_) {}
      return orig.call(this, container, params, ...rest);
    };
    window.turnstile.__patched = true;
  };
  // Cloudflare's script may attach window.turnstile asynchronously after
  // its own script tag loads, so poll briefly rather than assuming it's
  // present at document-start.
  install();
  const interval = setInterval(() => {
    install();
    if (window.turnstile && window.turnstile.__patched) clearInterval(interval);
  }, 100);
})();`;

async function preparePage(page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ "User-Agent": SPOOFED_USER_AGENT });
  await page.addInitScript(TURNSTILE_RENDER_HOOK);

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
