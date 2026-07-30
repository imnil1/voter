"""Port of lib/cookies.js — per-token cookie persistence, keyed by token hash
(not a raw prefix) so two tokens sharing a common prefix never collide."""
import hashlib
import json
import os
from pathlib import Path
from typing import Optional

COOKIE_DIR = Path(os.environ.get("COOKIE_DIR", "./cookies"))


def cookie_path(token: str) -> Path:
    token_hash = hashlib.sha256(token.encode()).hexdigest()[:16]
    return COOKIE_DIR / f"{token_hash}.json"


def load_cookies(token: str) -> Optional[list]:
    try:
        p = cookie_path(token)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def save_cookies(token: str, cookies: list) -> None:
    try:
        COOKIE_DIR.mkdir(parents=True, exist_ok=True)
        cookie_path(token).write_text(json.dumps(cookies, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[cookies] Failed to save: {e}")


def clear_cookies(token: str) -> None:
    try:
        p = cookie_path(token)
        if p.exists():
            p.unlink()
    except Exception:
        pass
