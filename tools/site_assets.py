"""Paths and inputs shared by the static release scripts."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROTO = ROOT / "prototype"
DIST = ROOT / "dist"
DEPLOY = DIST / "部署包"
ENTRY = PROTO / "ui-v4.html"
SINGLE = "xuanhu-single.html"


def web_files():
    yield ENTRY, "index.html"
    for path in sorted(PROTO.iterdir()):
        if path.suffix in (".js", ".css"):
            yield path, path.name


def version():
    game = (PROTO / "game.js").read_text(encoding="utf-8")
    match = re.search(r"^const APP_VERSION = '([^']+)';", game, re.MULTILINE)
    if not match:
        raise ValueError("prototype/game.js 缺少 APP_VERSION")
    latest = re.search(r"^const RELEASES\s*=\s*\[\s*\{\s*v:\s*'([^']+)'", game, re.MULTILINE)
    if not latest or latest[1] != match[1]:
        raise ValueError("APP_VERSION 与最新更新记录的版本号必须完全一致")
    return match[1]


def latest_apk():
    return max(DIST.glob("*.apk"), key=lambda p: (p.stat().st_mtime, p.name), default=None)
