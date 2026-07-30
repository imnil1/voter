"""Runs on CodeSandbox (or wherever the browser is hosted) — launches a
persistent Camoufox server exposing a WebSocket endpoint that the Railway
voter connects to via playwright.firefox.connect(ws_endpoint).

Per Camoufox's docs: a server instance only uses one browser instance, so
fingerprints don't rotate between sessions the way a fresh AsyncCamoufox(...)
launch would. That's an acceptable tradeoff here — the voter already
persists per-token cookies/sessions across runs, so a stable browser
identity is arguably more consistent with that than rotating fingerprints
would be.

humanize=True is set per playwright-captcha's own recommended Camoufox
stealth setup — it makes cursor movement and click timing look human
(curved paths, realistic delays) rather than instantaneous/robotic, which
both helps against Cloudflare's own risk scoring and may be relevant to
click-based Turnstile solving actually registering as a real interaction.

Requires: pip install camoufox[geoip]
First run also needs: camoufox fetch (downloads the browser binary)
"""
import os

from camoufox.server import launch_server

PORT = int(os.environ.get("CAMOUFOX_PORT", "1234"))
WS_PATH = os.environ.get("CAMOUFOX_WS_PATH", "voter")

if __name__ == "__main__":
    print(f"[camoufox-server] Starting on port {PORT}, path /{WS_PATH}...")
    # launch_server() blocks forever on its own (it communicates with a
    # subprocess and only returns/raises on that process exiting) — no
    # extra sleep loop needed after this call.
    launch_server(
        headless=True,
        geoip=True,
        humanize=True,
        port=PORT,
        ws_path=WS_PATH,
    )
