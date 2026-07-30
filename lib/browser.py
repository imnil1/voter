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
import os
from .logging import log


async def prepare_page(page):
    await page.set_viewport_size({"width": 1920, "height": 1080})
    return page


async def connect_browser(playwright):
    ws_endpoint = os.environ.get("CAMOUFOX_WS_URL")
    if not ws_endpoint:
        raise RuntimeError("CAMOUFOX_WS_URL is not set")

    log("[browser] Connecting to remote Camoufox server...")
    browser = await playwright.firefox.connect(ws_endpoint, timeout=30000)
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    page = await context.new_page()
    await prepare_page(page)
    viewport = page.viewport_size
    log(f"[browser] Viewport set to {viewport['width']}x{viewport['height']}" if viewport else "[browser] Viewport not set")
    return browser, context, page
