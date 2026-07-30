"""Port of lib/screenshot.js — debug screenshot/HTML capture on failures."""
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from .util import delay
from .logging import log

SCREENSHOT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "./screenshots"))


def _safe_label(label) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", str(label))


async def save_debug_screenshot(page, label, bot_id, reason, full_page=False):
    try:
        if page.is_closed():
            log(f"[screenshot:{label}] Skipped for bot {bot_id} ({reason}) — page already closed")
            return

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        try:
            await page.wait_for_load_state("load", timeout=5000)
        except Exception:
            pass
        await delay(500)

        try:
            await page.set_viewport_size({"width": 1920, "height": 1080})
        except Exception:
            pass

        if full_page:
            try:
                await page.evaluate("""
                    () => {
                        const fixedEls = [];
                        for (const el of document.querySelectorAll("*")) {
                            const pos = window.getComputedStyle(el).position;
                            if (pos === "fixed" || pos === "sticky") {
                                fixedEls.push([el, el.style.position]);
                                el.style.position = "absolute";
                            }
                        }
                        window.__debugScreenshotRestoreFixed = () => {
                            for (const [el, original] of fixedEls) el.style.position = original;
                        };
                    }
                """)
            except Exception:
                pass

        safe_label = _safe_label(label)
        timestamp = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
        filename = f"{safe_label}_{bot_id}_{reason}_{timestamp}.png"
        filepath = SCREENSHOT_DIR / filename

        try:
            await page.screenshot(path=str(filepath), full_page=full_page, timeout=15000)
            log(f"[screenshot:{label}] Saved debug screenshot for bot {bot_id}: {filename}")
        finally:
            if full_page:
                try:
                    await page.evaluate("""
                        () => {
                            if (window.__debugScreenshotRestoreFixed) {
                                window.__debugScreenshotRestoreFixed();
                                delete window.__debugScreenshotRestoreFixed;
                            }
                        }
                    """)
                except Exception:
                    pass
    except Exception as err:
        msg = str(err)
        if re.search(r"closed", msg, re.IGNORECASE):
            log(f"[screenshot:{label}] Could not capture for bot {bot_id} ({reason}) — page/context/browser closed before or during capture")
        else:
            log(f"[screenshot:{label}] Failed to save screenshot: {msg}")


async def save_debug_html(page, label, bot_id, reason):
    try:
        if page.is_closed():
            log(f"[html:{label}] Skipped for bot {bot_id} ({reason}) — page already closed")
            return

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        html = await page.content()

        safe_label = _safe_label(label)
        timestamp = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
        filename = f"{safe_label}_{bot_id}_{reason}_{timestamp}.html"
        filepath = SCREENSHOT_DIR / filename

        filepath.write_text(html, encoding="utf-8")
        log(f"[html:{label}] Saved debug HTML for bot {bot_id}: {filename}")
    except Exception as err:
        msg = str(err)
        if re.search(r"closed", msg, re.IGNORECASE):
            log(f"[html:{label}] Could not capture for bot {bot_id} ({reason}) — page/context/browser closed before or during capture")
        else:
            log(f"[html:{label}] Failed to save HTML: {msg}")
