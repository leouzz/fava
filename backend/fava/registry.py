"""Optional enrichment from the community figure registry (TAGS.md).

The registry is a Markdown table: | ID | Language | Figure Name | SKU | NFC |.
It is downloaded at import time (and cached in the data dir) instead of being
bundled, so the project does not redistribute it.
"""

from __future__ import annotations

import logging
import re
import urllib.request
from dataclasses import dataclass

from .config import settings

log = logging.getLogger(__name__)

LANG_CODES = {
    "italian": "it", "english": "en", "french": "fr", "spanish": "es", "catalan": "ca",
    "german": "de", "portuguese": "pt", "dutch": "nl",
}


@dataclass
class Entry:
    id: str
    language: str | None
    name: str
    sku: str | None
    language_label: str = ""  # as written in the registry, e.g. "Italian/English", "Latam"


def _parse(md: str) -> dict[str, Entry]:
    out: dict[str, Entry] = {}
    for line in md.splitlines():
        m = re.match(r"^\|\s*(\d{4})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|", line)
        if not m:
            continue
        fid, lang, name, sku = (x.strip() for x in m.groups())
        first = lang.split("/")[0].strip().lower()
        out[fid] = Entry(fid, LANG_CODES.get(first), name, sku or None, lang)
    return out


def load(download: bool = True) -> dict[str, Entry]:
    """The registry; with download=False only the cached copy (fetched once if missing)."""
    cache = settings.data_dir / "registry.md"
    text = None
    if settings.registry_url and (download or not cache.exists()):
        try:
            req = urllib.request.Request(settings.registry_url, headers={"User-Agent": "fava-importer"})
            with urllib.request.urlopen(req, timeout=10) as r:
                text = r.read().decode("utf-8")
            cache.write_text(text, encoding="utf-8")
        except Exception as e:
            log.info("registry download failed (%s), using cache if present", e)
    if text is None and cache.exists():
        text = cache.read_text(encoding="utf-8")
    return _parse(text) if text else {}
