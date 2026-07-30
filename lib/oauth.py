"""Port of lib/oauth.js."""
import json
import re
import time

from .util import delay
from .logging import log
from .screenshot import save_debug_screenshot

AUTHORIZE_PATTERN = re.compile(r"authoriz|allow|yes", re.I)
SCROLLABLE_PATTERN = re.compile(r"authoriz|allow|yes|keep scrolling", re.I)


async def has_login_button(page) -> bool:
    login_btn = page.locator("button", has_text="Login").first
    try:
        return await login_btn.is_visible()
    except Exception:
        return False


async def is_logged_in_to_topgg(page) -> bool:
    try:
        await page.goto("https://top.gg", wait_until="domcontentloaded", timeout=30000)
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
        return not await has_login_button(page)
    except Exception:
        return False


async def do_oauth(page, token, label):
    log(f"[auth:{label}] Setting Discord token in localStorage...")
    # Playwright's Python add_init_script doesn't take a (fn, arg) pair like
    # JS's addInitScript — embed the token directly via json.dumps (twice,
    # so the token ends up as a JSON-quoted string literal inside the JS
    # source, matching the original `"${t}"` wrapping in the Node version).
    await page.add_init_script(f'window.localStorage.setItem("token", {json.dumps(json.dumps(token))});')

    await page.goto("https://top.gg", wait_until="domcontentloaded", timeout=30000)
    try:
        await page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass

    log(f"[auth:{label}] Clicking login button...")
    login_visible = await has_login_button(page)

    if not login_visible:
        log(f"[auth:{label}] Already logged in")
        return

    login_btn = page.locator("button", has_text="Login").first
    await login_btn.click()
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
    except Exception as err:
        await save_debug_screenshot(page, label, "oauth", "post-login-click-timeout", True)
        raise err

    log(f"[auth:{label}] Waiting for Discord consent page to render...")
    scrollable_btn = page.locator("button", has_text=SCROLLABLE_PATTERN).first
    try:
        await scrollable_btn.wait_for(state="visible", timeout=30000)
    except Exception as err:
        await save_debug_screenshot(page, label, "oauth", "authorize-button-missing", True)
        raise err

    try:
        scrolled = await page.evaluate("""
            () => {
                const el = [...document.querySelectorAll("div[class*='scrollerBase']")][0];
                if (el) {
                    el.scrollTop = el.scrollHeight;
                    return true;
                }
                return false;
            }
        """)
    except Exception:
        scrolled = False
    log(f"[auth:{label}] Scrolled consent list to bottom: {scrolled}")
    await delay(500)

    authorize_btn = page.locator("button", has_text=AUTHORIZE_PATTERN).first
    try:
        await authorize_btn.wait_for(state="visible", timeout=15000)
        authorize_visible = True
    except Exception:
        authorize_visible = False

    if not authorize_visible:
        log(f"[auth:{label}] Authorize still hidden after scroll — trying zoom-out fallback...")
        try:
            await page.evaluate('document.body.style.zoom = "0.5";')
        except Exception:
            pass
        await delay(1000)
        try:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight);")
        except Exception:
            pass
        await delay(1000)
        try:
            await page.evaluate("""
                () => {
                    const el = [...document.querySelectorAll("[class*='scroller']")][0];
                    if (el) el.scrollTop = el.scrollHeight;
                }
            """)
        except Exception:
            pass
        await delay(1000)

        authorize_btn = page.locator("button", has_text=AUTHORIZE_PATTERN).first
        try:
            await authorize_btn.wait_for(state="visible", timeout=15000)
            authorize_visible = True
        except Exception:
            authorize_visible = False

    if not authorize_visible:
        await save_debug_screenshot(page, label, "oauth", "authorize-still-scrolling", True)
        raise Exception("Authorize button never became visible after scroll and zoom-out attempts")

    log(f"[auth:{label}] Clicking authorize...")
    await authorize_btn.click()

    try:
        await page.evaluate('document.body.style.zoom = "1";')
    except Exception:
        pass

    await page.wait_for_load_state("domcontentloaded", timeout=15000)

    OAUTH_SETTLE_TIMEOUT_S = 15
    settle_start = time.monotonic()
    still_logged_out = True
    while time.monotonic() - settle_start < OAUTH_SETTLE_TIMEOUT_S:
        still_logged_out = await has_login_button(page)
        if not still_logged_out:
            break
        await delay(500)

    if still_logged_out:
        current_url = page.url
        log(f"[auth:{label}] Still shows logged out after authorize (waited {OAUTH_SETTLE_TIMEOUT_S}s) — current URL: {current_url}")
        await save_debug_screenshot(page, label, "oauth", "still-logged-out-after-authorize", True)
        raise Exception("Authorization failed - Discord OAuth did not complete")

    log(f"[auth:{label}] Authorization successful (on {page.url})")
    await save_debug_screenshot(page, label, "oauth", "post-authorize-confirmed", True)
