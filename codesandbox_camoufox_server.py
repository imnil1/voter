"""Runs on CodeSandbox (or wherever the browser is hosted) — launches a
persistent Camoufox server exposing a WebSocket endpoint that the Railway
voter connects to via playwright.firefox.connect(ws_endpoint).

Per Camoufox's docs: a server instance only uses one browser instance, so
fingerprints don't rotate between sessions the way a fresh AsyncCamoufox(...)
launch would. That's an acceptable tradeoff here — the voter already
persists per-token cookies/sessions across runs, so a stable browser
identity is arguably more consistent with that than rotating fingerprints
would be.

Requires: pip install camoufox[geoip]
First run also needs: camoufox fetch (downloads the browser binary)
"""
import os

from camoufox.server import launch_server

PORT = int(os.environ.get("CAMOUFOX_PORT", "1234"))
WS_PATH = os.environ.get("CAMOUFOX_WS_PATH", "voter")

if __name__ == "__main__":
    print(f"[camoufox-server] Starting on port {PORT}, path /{WS_PATH}...")
    server = launch_server(
        headless=True,
        geoip=True,
        port=PORT,
        ws_path=WS_PATH,
    )
    print(f"[camoufox-server] Ready. WS endpoint: {server.ws_endpoint()}")
    print("[camoufox-server] Set this as CAMOUFOX_WS_URL in the voter's environment.")

    # Keep the process alive — launch_server runs the server in the
    # background; without blocking here, the script would exit immediately
    # and tear the server down with it.
    try:
        import time
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("[camoufox-server] Shutting down...")
        server.close()
