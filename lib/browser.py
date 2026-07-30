"""Port of lib/browser.js.

Architecture change from the original Node/browserless-v2 setup: instead of
`chromium.connectOverCDP()` against a self-hosted browserless-v2 service,
this connects to a remote Camoufox server (launched via
`camoufox.server.launch_server(...)` on CodeSandbox) using Playwright's
`firefox.connect()` — Camoufox is a hardened Firefox build, and per
Camoufox's own docs, `connect_over_cdp` is Chromium-only; `firefox.connect()`
against Camoufox's own websocket server is the correct connection method.

The sitekey-capture hooks (network listener + turnstile.render() patch) from
the original browser.js are dropped here: those existed to feed sitekeys to
an *external* 2captcha-style solver API. That approach is replaced entirely
by playwright-captcha's ClickSolver, which clicks the real checkbox directly
in-page and never needs the sitekey at all.
"""
import asyncio
import os
from .logging import log


async def prepare_page(page):
    await page.set_viewport_size({"width": 1920, "height": 1080})
    return page


async def connect_browser(playwright, max_attempts=5, base_delay_s=2):
    """Connects to the remote Camoufox server, retrying with backoff.

    The CodeSandbox Devbox hosting Camoufox hibernates between scheduled
    votes to save credits, and wakes automatically on an incoming
    WebSocket connection (per CodeSandbox's automaticWakeupConfig).
    Resuming from a snapshot is fast (CodeSandbox states 0.5-2s) but not
    instant, so the very first connection attempt can race the wake-up —
    retry a few times with a short backoff rather than failing the whole
    vote run on one slow wake.
    """
    ws_endpoint = os.environ.get("CAMOUFOX_WS_URL")
    if not ws_endpoint:
        raise RuntimeError("CAMOUFOX_WS_URL is not set")

    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            log(f"[browser] Connecting to remote Camoufox server (attempt {attempt}/{max_attempts})...")
            browser = await playwright.firefox.connect(ws_endpoint, timeout=30000)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = await context.new_page()
            await prepare_page(page)
            viewport = page.viewport_size
            log(f"[browser] Viewport set to {viewport['width']}x{viewport['height']}" if viewport else "[browser] Viewport not set")
            return browser, context, page
        except Exception as err:
            last_err = err
            if attempt < max_attempts:
                delay_s = base_delay_s * attempt  # 2s, 4s, 6s, 8s
                log(f"[browser] Connection attempt {attempt} failed ({err}) — Sandbox may still be waking from hibernation, retrying in {delay_s}s...")
                await asyncio.sleep(delay_s)

    raise RuntimeError(f"Could not connect to Camoufox server after {max_attempts} attempts: {last_err}")
