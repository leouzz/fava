from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator

from .config import settings

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS albums (
    id            TEXT PRIMARY KEY,          -- 4-digit figure id (0010) or audiobook id (ab + 10 hex)
    kind          TEXT NOT NULL DEFAULT 'faba',  -- faba | audiobook
    audience      TEXT,                      -- audiobooks: kids | adults | NULL (unknown)
    title         TEXT NOT NULL,
    title_source  TEXT,
    subtitle      TEXT,
    category      TEXT,                      -- stories | music | rhymes | learning | other | audiobook
    category_source TEXT,
    language      TEXT,
    series        TEXT,
    sku           TEXT,
    track_count   INTEGER DEFAULT 0,
    duration      REAL DEFAULT 0,
    has_cover     INTEGER DEFAULT 0,
    cover_source  TEXT,                      -- booklet | catalog | retailer | manual
    duplicate_of  TEXT,                      -- album with the very same audio
    description   TEXT,                      -- from the online product page
    age           TEXT,                      -- e.g. "3-5"
    contents      TEXT,                      -- JSON [{name, items}]
    product_url   TEXT,
    color         TEXT,
    credits       TEXT,                      -- JSON {role: [names]}
    has_lyrics    INTEGER DEFAULT 0,
    online_fields TEXT,                      -- audiobooks: JSON list of fields filled from the web
    sources       TEXT,                      -- JSON list: mki, mp3, pdf
    status        TEXT,                      -- ok | warning | error
    added_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id      TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,          -- CPxx position (1-based)
    title         TEXT NOT NULL,
    title_source  TEXT,
    duration      REAL DEFAULT 0,
    bitrate       INTEGER,
    size          INTEGER,
    source_kind   TEXT NOT NULL,             -- mki | mp3 | m4b | m4a
    source_path   TEXT NOT NULL,
    alt_path      TEXT,                      -- the other copy, if any
    is_extra      INTEGER DEFAULT 0,         -- Faba intro / outro jingle
    lyrics        TEXT,
    valid         INTEGER DEFAULT 1,
    chapters      TEXT,                      -- audiobooks: JSON [{start, title}] inside this file
    UNIQUE(album_id, idx)
);

CREATE TABLE IF NOT EXISTS documents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id  TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,                 -- Documento | Testi | Attivita
    path      TEXT NOT NULL,
    name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id  TEXT,
    track_idx INTEGER,
    level     TEXT NOT NULL,                 -- info | warning | error
    code      TEXT NOT NULL,
    message   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
    album_id  TEXT PRIMARY KEY,
    added_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
    album_id   TEXT PRIMARY KEY,
    track_id   INTEGER NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_links (
    album_id   TEXT PRIMARY KEY,
    source     TEXT NOT NULL,                -- myfaba | retailer host
    url        TEXT NOT NULL,
    method     TEXT                          -- sku | title | review
);

CREATE TABLE IF NOT EXISTS cover_candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id      TEXT NOT NULL,
    source        TEXT NOT NULL,             -- myfaba, italiano-bello.com, ...
    product_url   TEXT NOT NULL,
    product_name  TEXT,
    image         TEXT NOT NULL,             -- file name in data/catalog/img
    score         REAL,
    status        TEXT NOT NULL,             -- auto | pending | accepted | rejected | option
    data          TEXT,                      -- audiobooks: JSON details of the match (bookinfo.Result)
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(album_id, product_url)
);

CREATE TABLE IF NOT EXISTS file_cache (
    path   TEXT PRIMARY KEY,
    stamp  TEXT NOT NULL,                    -- size:mtime
    data   TEXT NOT NULL                     -- JSON
);

-- choices made from the UI that must survive a re-import
CREATE TABLE IF NOT EXISTS album_overrides (
    album_id  TEXT PRIMARY KEY,
    audience  TEXT                           -- kids | adults
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    album_id UNINDEXED, track_id UNINDEXED, kind UNINDEXED, text,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id, idx);
"""

# User state lives in a separate file (attached as "u"): the importer rebuilds the
# catalogue in one long transaction on fava.db, and saving a resume position or a
# favourite must never wait for it. Unqualified table names resolve to "u" because
# these tables do not exist in the main database.
USER_SCHEMA = """
CREATE TABLE IF NOT EXISTS u.profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    avatar      TEXT NOT NULL DEFAULT 'face:bear',   -- face:<name> | figure:<album id>
    color       TEXT NOT NULL DEFAULT '#ff6b5e',
    languages   TEXT,                                -- "it,fr" (NULL = all)
    audiobooks  TEXT NOT NULL DEFAULT 'all',             -- all | kids | none
    easy        INTEGER NOT NULL DEFAULT 0,          -- 1 = Easy mode (NFC cards, big buttons)
    pin         TEXT,                                -- hashed PIN (auth.hash_pin): leaving Easy mode, entering
    pin_login   INTEGER NOT NULL DEFAULT 0,          -- 1 = ask the PIN when switching to this profile
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS u.profile_favorites (
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    album_id    TEXT NOT NULL,
    added_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, album_id)
);

CREATE TABLE IF NOT EXISTS u.profile_bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    album_id    TEXT NOT NULL,
    track_idx   INTEGER NOT NULL,                    -- tracks.idx (stable across imports)
    position    REAL NOT NULL,
    note        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS u.bookmarks_album ON profile_bookmarks(profile_id, album_id);

CREATE TABLE IF NOT EXISTS u.profile_progress (
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    album_id    TEXT NOT NULL,
    track_id    INTEGER NOT NULL,
    position    REAL NOT NULL DEFAULT 0,
    updated_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (profile_id, album_id)
);

-- NFC cards paired to an album or audiobook (Easy mode)
CREATE TABLE IF NOT EXISTS u.nfc_tags (
    uid          TEXT PRIMARY KEY,                   -- card serial number, lowercase hex without separators
    target_kind  TEXT NOT NULL DEFAULT 'album',      -- album (room for playlists later)
    target_id    TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
);
"""

MIGRATIONS = {"cover_source": "TEXT", "duplicate_of": "TEXT", "description": "TEXT", "age": "TEXT",
              "contents": "TEXT", "product_url": "TEXT", "kind": "TEXT NOT NULL DEFAULT 'faba'",
              "audience": "TEXT", "online_fields": "TEXT"}

CANDIDATE_MIGRATIONS = {"data": "TEXT"}

TRACK_MIGRATIONS = {"chapters": "TEXT"}

PROFILE_MIGRATIONS = {"languages": "TEXT", "audiobooks": "TEXT NOT NULL DEFAULT 'all'",
                      "easy": "INTEGER NOT NULL DEFAULT 0", "pin": "TEXT",
                      "pin_login": "INTEGER NOT NULL DEFAULT 0"}

_lock = threading.Lock()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ? AS u", (str(settings.data_dir / "user.db"),))
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with _lock, connect() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA u.journal_mode=WAL")
        conn.executescript(USER_SCHEMA)
        # lightweight migrations for databases created by older versions
        for schema, table, cols_ddl in (("main", "albums", MIGRATIONS), ("main", "tracks", TRACK_MIGRATIONS),
                                        ("main", "cover_candidates", CANDIDATE_MIGRATIONS),
                                        ("u", "profiles", PROFILE_MIGRATIONS)):
            cols = {r[1] for r in conn.execute(f"PRAGMA {schema}.table_info({table})")}
            for col, ddl in cols_ddl.items():
                if col not in cols:
                    conn.execute(f"ALTER TABLE {schema}.{table} ADD COLUMN {col} {ddl}")
        conn.execute("CREATE INDEX IF NOT EXISTS albums_kind ON albums(kind)")
        # profiles used to live in fava.db: move them to user.db once
        main_tables = {r[0] for r in conn.execute("SELECT name FROM main.sqlite_master WHERE type='table'")}
        if "profiles" in main_tables:
            if conn.execute("SELECT COUNT(*) FROM u.profiles").fetchone()[0] == 0:
                cols = {r[1] for r in conn.execute("PRAGMA main.table_info(profiles)")}
                lang = "languages" if "languages" in cols else "NULL"
                conn.execute(f"INSERT INTO u.profiles(id, name, avatar, color, languages, created_at) "
                             f"SELECT id, name, avatar, color, {lang}, created_at FROM main.profiles")
                if "profile_favorites" in main_tables:
                    conn.execute("INSERT OR IGNORE INTO u.profile_favorites SELECT * FROM main.profile_favorites")
                if "profile_progress" in main_tables:
                    conn.execute("INSERT OR IGNORE INTO u.profile_progress SELECT * FROM main.profile_progress")
            for t in ("profile_favorites", "profile_progress", "profiles"):
                if t in main_tables:
                    conn.execute(f"DROP TABLE main.{t}")
        # first run with profiles: create a default one and move legacy user data to it
        if conn.execute("SELECT COUNT(*) FROM u.profiles").fetchone()[0] == 0:
            conn.execute("INSERT INTO u.profiles(name, avatar, color) VALUES('Famiglia', 'face:bear', '#ff6b5e')")
            pid = conn.execute("SELECT id FROM u.profiles ORDER BY id LIMIT 1").fetchone()[0]
            conn.execute("INSERT OR IGNORE INTO u.profile_favorites(profile_id, album_id, added_at) "
                         "SELECT ?, album_id, added_at FROM main.favorites", (pid,))
            conn.execute("INSERT OR IGNORE INTO u.profile_progress(profile_id, album_id, track_id, position, "
                         "updated_at) SELECT ?, album_id, track_id, position, updated_at FROM main.progress", (pid,))


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
