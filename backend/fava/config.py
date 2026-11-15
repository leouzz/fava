from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    asset_dir: Path = field(default_factory=lambda: Path(_env("FAVA_ASSET_DIR", "./asset")).resolve())
    data_dir: Path = field(default_factory=lambda: Path(_env("FAVA_DATA_DIR", "./data")).resolve())
    static_dir: Path = field(default_factory=lambda: Path(
        _env("FAVA_STATIC_DIR", str(Path(__file__).resolve().parent.parent / "static"))))
    # Optional passwords (see auth.py). Empty = open access.
    password: str = field(default_factory=lambda: _env("FAVA_PASSWORD", ""))
    admin_password: str = field(default_factory=lambda: _env("FAVA_ADMIN_PASSWORD", ""))
    # Prefer the original MKI files (decoded on the fly) or decoded MP3 copies.
    prefer: str = field(default_factory=lambda: _env("FAVA_PREFER", "mki").lower())
    # Public base URL used to build absolute media URLs for Chromecast,
    # e.g. http://192.168.1.20:8080. Empty = use the browser's origin.
    public_url: str = field(default_factory=lambda: _env("FAVA_PUBLIC_URL", "").rstrip("/"))
    # Optional community registry of figure ids (language, official name, SKU).
    registry_url: str = field(default_factory=lambda: _env(
        "FAVA_REGISTRY_URL",
        "https://raw.githubusercontent.com/wansors/myfaba-hacks/main/TAGS.md"))
    import_on_start: bool = field(default_factory=lambda: _env("FAVA_IMPORT_ON_START", "auto") != "never")
    import_always: bool = field(default_factory=lambda: _env("FAVA_IMPORT_ON_START", "auto") == "always")
    extract_covers: bool = field(default_factory=lambda: _env("FAVA_COVERS", "1") != "0")
    # Fetch missing covers from the official online catalogue (cached in data/catalog).
    online_covers: bool = field(default_factory=lambda: _env("FAVA_ONLINE_COVERS", "1") != "0")
    catalog_stores: list = field(default_factory=lambda: [s.strip().rstrip("/") for s in _env(
        "FAVA_CATALOG_STORES", "https://www.myfaba.it,https://www.myfaba.es,https://www.myfaba.fr"
    ).split(",") if s.strip()])
    # Read description, age range and contents (story/song titles) of matched products.
    online_details: bool = field(default_factory=lambda: _env("FAVA_ONLINE_DETAILS", "1") != "0")
    # Retailer product sitemaps (Yoast/WordPress) used for retired figures; "" disables.
    retailer_sitemaps: list = field(default_factory=lambda: [s.strip() for s in _env(
        "FAVA_RETAILER_SITEMAPS", "https://italiano-bello.com/sitemap_index.xml").split(",") if s.strip()])
    # Number of bytes compared between an MKI and its MP3 copy during verification.
    verify_bytes: int = field(default_factory=lambda: int(_env("FAVA_VERIFY_BYTES", "65536")))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "fava.db"

    @property
    def covers_dir(self) -> Path:
        return self.data_dir / "covers"


settings = Settings()
