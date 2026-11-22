"""Online details for audiobooks: cover, description, author, genre.

Sources (free, no API key):

* Apple Books, through the public iTunes Search API (``media=audiobook``):
  high-resolution artwork, author, description, genre;
* Open Library (search + work pages), as a fallback for books Apple does not list.

Only the title and author are sent. Answers and images are cached under
``<data>/catalog`` (30 days), so each lookup happens once. Tags read from the
files always win: online data only fills what is missing.

Matching mirrors the Faba covers: a near-identical title *and* author is applied
automatically ("auto"), anything less certain becomes a "pending" candidate that
parents confirm or discard from Gestione; decisions survive re-imports.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import re
import time
import urllib.parse
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import audiobooks, catalog
from .config import settings

log = logging.getLogger(__name__)

TTL = 30 * 86400
EMPTY_TTL = 7 * 86400
APPLE_GAP = 3.1  # the iTunes Search API allows ~20 requests per minute
COUNTRY = {"it": "it", "fr": "fr", "es": "es", "de": "de", "en": "us", "ca": "es"}
SOURCE_NAME = {"apple": "Apple Books", "openlibrary": "Open Library"}
RE_NOISE = re.compile(r"\((?:[^)]*(?:audiolibro|audiobook|unabridged|integrale|abridged|ridotta)[^)]*)\)|"
                      r"\b(?:audiolibro|audiobook|unabridged|versione integrale|edizione integrale)\b", re.I)

_last_apple = 0.0


@dataclass
class Result:
    source: str          # apple | openlibrary
    url: str             # product / work page (unique per candidate)
    title: str
    author: str | None = None
    description: str | None = None
    genre: str | None = None
    year: str | None = None
    image_url: str | None = None   # full size
    thumb_url: str | None = None   # small, for the search list
    kids: bool = False
    work: str | None = None        # Open Library work key (description fetched lazily)
    score: float = 0.0

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "Result":
        return Result(**{k: v for k, v in d.items() if k in Result.__dataclass_fields__})


# --------------------------------------------------------------------------- cache

class Cache:
    def __init__(self) -> None:
        self.path = catalog._dir() / "books.json"
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}
        self.dirty = 0

    def get_json(self, url: str, apple: bool = False):
        hit = self.data.get(url)
        if hit and time.time() - hit["t"] < (TTL if hit["v"] else EMPTY_TTL):
            return hit["v"]
        global _last_apple
        if apple:
            wait = APPLE_GAP - (time.time() - _last_apple)
            if wait > 0:
                time.sleep(wait)
        try:
            v = json.loads(catalog._get(url, {"Accept": "application/json"}))
        finally:
            if apple:
                _last_apple = time.time()
        self.data[url] = {"t": time.time(), "v": v}
        self.dirty += 1
        if self.dirty >= 10:
            self.save()
        return v

    def save(self) -> None:
        if self.dirty:
            self.path.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
            self.dirty = 0


def image_file(url: str) -> Path | None:
    """Download (once) and convert to PNG, in data/catalog/img."""
    d = catalog._dir() / "img"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"book-{hashlib.sha1(url.encode()).hexdigest()[:16]}.png"
    if p.exists():
        return p
    try:
        png = audiobooks.to_png(catalog._get(url))
    except Exception as e:
        log.info("cover download failed %s: %s", url, e)
        return None
    if not png:
        return None
    p.write_bytes(png)
    return p


# --------------------------------------------------------------------------- sources

def _text(s: str | None) -> str | None:
    if not s:
        return None
    s = re.sub(r"<\s*br\s*/?>|</p>", "\n", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s or None


def _is_kids(*texts: str | None) -> bool:
    t = " ".join(x for x in texts if x).lower()
    return any(w in t for w in audiobooks.KIDS_WORDS)


def apple(cache: Cache, term: str, lang: str | None) -> list[Result]:
    q = urllib.parse.urlencode({"term": term, "media": "audiobook", "entity": "audiobook",
                                "country": COUNTRY.get(lang or "", "it"), "limit": 10})
    data = cache.get_json(f"https://itunes.apple.com/search?{q}", apple=True)
    out = []
    for r in data.get("results", []):
        title = r.get("collectionName") or r.get("trackName")
        url = r.get("collectionViewUrl")
        if not title or not url:
            continue
        art = r.get("artworkUrl100") or r.get("artworkUrl60")
        out.append(Result(
            source="apple", url=url.split("?")[0], title=title, author=r.get("artistName"),
            description=_text(r.get("description")), genre=r.get("primaryGenreName"),
            year=(r.get("releaseDate") or "")[:4] or None,
            image_url=re.sub(r"/\d+x\d+bb\.", "/1000x1000bb.", art) if art else None, thumb_url=art,
            kids=_is_kids(r.get("primaryGenreName"))))
    return out


def openlibrary(cache: Cache, title: str, author: str | None) -> list[Result]:
    params = {"title": title, "limit": 5,
              "fields": "key,title,author_name,cover_i,first_publish_year,subject"}
    if author:
        params["author"] = author
    data = cache.get_json("https://openlibrary.org/search.json?" + urllib.parse.urlencode(params))
    out = []
    for d in data.get("docs", []):
        if not d.get("key") or not d.get("title"):
            continue
        cover = d.get("cover_i")
        subjects = " ".join((d.get("subject") or [])[:40])
        out.append(Result(
            source="openlibrary", url=f"https://openlibrary.org{d['key']}", title=d["title"],
            author=", ".join((d.get("author_name") or [])[:3]) or None,
            year=str(d["first_publish_year"]) if d.get("first_publish_year") else None,
            image_url=f"https://covers.openlibrary.org/b/id/{cover}-L.jpg" if cover else None,
            thumb_url=f"https://covers.openlibrary.org/b/id/{cover}-M.jpg" if cover else None,
            kids=_is_kids(subjects), work=d["key"]))
    return out


def complete(cache: Cache, r: Result) -> Result:
    """Open Library descriptions live on the work page: fetch it for the chosen result only."""
    if r.source == "openlibrary" and r.work and not r.description:
        try:
            w = cache.get_json(f"https://openlibrary.org{r.work}.json")
            desc = w.get("description")
            r.description = _text(desc.get("value") if isinstance(desc, dict) else desc)
        except Exception as e:
            log.info("open library work %s: %s", r.work, e)
    return r


# --------------------------------------------------------------------------- matching

def _clean(title: str) -> str:
    t = RE_NOISE.sub(" ", title)
    return re.sub(r"\s+", " ", t).strip(" -–:")


def _short(title: str) -> str:
    return re.split(r"\s*[:–]\s*|\s+-\s+", _clean(title))[0]


def score(r: Result, title: str, author: str | None) -> tuple[float, float]:
    ts = max(catalog.similarity(_clean(title), _clean(r.title)),
             catalog.similarity(_short(title), _short(r.title)))
    if not author or not r.author:
        return ts, -1.0
    ours = audiobooks.split_names(author) or [author]
    theirs = audiobooks.split_names(r.author) or [r.author]
    au = max(catalog.similarity(a, b) for a in ours for b in theirs)
    # "Saint-Exupéry" vs "Antoine de Saint-Exupéry"
    if any(catalog._norm(a).split()[-1:] == catalog._norm(b).split()[-1:] for a in ours for b in theirs):
        au = max(au, 0.85)
    return ts, au


def verdict(ts: float, au: float) -> str | None:
    """auto (apply), pending (ask), or None (ignore)."""
    if au >= 0.75 and ts >= 0.88:
        return "auto"
    if (au >= 0.5 and ts >= 0.7) or (au < 0 and ts >= 0.85):
        return "pending"
    return None


def search(cache: Cache, title: str, author: str | None, lang: str | None,
           sources: tuple[str, ...] = ("apple", "openlibrary")) -> list[Result]:
    """Results from every source, best first (score = title × author similarity)."""
    results: list[Result] = []
    term = f"{_clean(title)} {author or ''}".strip()
    if "apple" in sources:
        try:
            got = apple(cache, term, lang)
            if not got and author:
                got = apple(cache, _clean(title), lang)
            results += got
        except Exception as e:
            log.info("apple books lookup failed: %s", e)
    if "openlibrary" in sources:
        try:
            results += openlibrary(cache, _short(title), author)
        except Exception as e:
            log.info("open library lookup failed: %s", e)
    seen, uniq = set(), []
    for r in results:
        if r.url in seen:
            continue
        seen.add(r.url)
        ts, au = score(r, title, author)
        r.score = round(ts * (au if au >= 0 else 0.8) + (0.02 if r.source == "apple" else 0), 3)
        uniq.append(r)
    return sorted(uniq, key=lambda r: -r.score)


# --------------------------------------------------------------------------- applying

def apply(conn, album_id: str, r: Result) -> list[str]:
    """Fill what the files did not provide. Returns the fields that were filled."""
    from .importer import _cover_color

    row = conn.execute("SELECT has_cover, description, subtitle, audience, credits FROM albums WHERE id=?",
                       (album_id,)).fetchone()
    if not row:
        return []
    fields = []
    if not row["has_cover"] and r.image_url and settings.online_covers:
        img = image_file(r.image_url)
        if img:
            png = img.read_bytes()
            (settings.covers_dir / f"{album_id}.png").write_bytes(png)
            conn.execute("UPDATE albums SET has_cover=1, cover_source=?, color=? WHERE id=?",
                         (r.source, _cover_color(png, figure=False), album_id))
            fields.append("cover")
    if settings.online_details:
        if not row["description"] and r.description:
            conn.execute("UPDATE albums SET description=? WHERE id=?", (r.description, album_id))
            conn.execute("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)",
                         (album_id, None, "info", r.description))
            fields.append("description")
        if not row["subtitle"] and r.author:
            credits = json.loads(row["credits"] or "{}")
            credits["author"] = audiobooks.split_names(r.author) or [r.author]
            conn.execute("UPDATE albums SET subtitle=?, credits=? WHERE id=?",
                         (r.author, json.dumps(credits, ensure_ascii=False), album_id))
            conn.execute("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)",
                         (album_id, None, "credit", r.author))
            fields.append("author")
        if row["audience"] is None and r.kids:
            conn.execute("UPDATE albums SET audience='kids' WHERE id=?", (album_id,))
            fields.append("audience")
    conn.execute("UPDATE albums SET product_url=?, online_fields=? WHERE id=?",
                 (r.url, json.dumps(fields), album_id))
    return fields


def undo(conn, album_id: str) -> None:
    """Remove what apply() filled (the candidate was discarded)."""
    row = conn.execute("SELECT online_fields, credits, cover_source FROM albums WHERE id=?", (album_id,)).fetchone()
    if not row:
        return
    fields = json.loads(row["online_fields"] or "[]")
    if "cover" in fields and row["cover_source"] in SOURCE_NAME:
        conn.execute("UPDATE albums SET has_cover=0, cover_source=NULL, color=NULL WHERE id=?", (album_id,))
        (settings.covers_dir / f"{album_id}.png").unlink(missing_ok=True)
    if "description" in fields:
        conn.execute("UPDATE albums SET description=NULL WHERE id=?", (album_id,))
    if "author" in fields:
        credits = json.loads(row["credits"] or "{}")
        credits.pop("author", None)
        conn.execute("UPDATE albums SET subtitle=NULL, credits=? WHERE id=?",
                     (json.dumps(credits, ensure_ascii=False), album_id))
    if "audience" in fields:
        conn.execute("UPDATE albums SET audience=NULL WHERE id=?", (album_id,))
    conn.execute("UPDATE albums SET product_url=NULL, online_fields=NULL WHERE id=?", (album_id,))


def store_candidate(conn, album_id: str, r: Result, status: str, image: Path | None) -> int:
    """Upsert into cover_candidates (shared with the Faba covers review)."""
    conn.execute(
        "INSERT INTO cover_candidates(album_id, source, product_url, product_name, image, score, status, data) "
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(album_id, product_url) DO UPDATE SET "
        "product_name=excluded.product_name, image=CASE WHEN excluded.image<>'' THEN excluded.image "
        "ELSE cover_candidates.image END, score=excluded.score, data=excluded.data, "
        "status=CASE WHEN cover_candidates.status IN ('rejected','accepted') AND excluded.status<>'accepted' "
        "THEN cover_candidates.status ELSE excluded.status END",
        (album_id, r.source, r.url, f"{r.title}" + (f" · {r.author}" if r.author else ""),
         image.name if image else "", r.score, status, json.dumps(r.to_json(), ensure_ascii=False)))
    return conn.execute("SELECT id FROM cover_candidates WHERE album_id=? AND product_url=?",
                        (album_id, r.url)).fetchone()[0]


@dataclass
class PhaseStats:
    auto: int = 0
    pending: int = 0
    reused: int = 0
    failed: list[str] = field(default_factory=list)


def import_phase(conn, st, issue) -> PhaseStats:
    """During the import: reuse decisions, look up books with missing details."""
    stats = PhaseStats()
    books = conn.execute(
        "SELECT id, title, subtitle, language, has_cover, description FROM albums "
        "WHERE kind='audiobook' ORDER BY title").fetchall()
    if not books:
        return stats
    decided: dict[str, dict] = {}
    rejected: dict[str, set] = {}
    for c in conn.execute("SELECT album_id, product_url, status, data FROM cover_candidates "
                          "WHERE album_id LIKE 'ab%'"):
        if c["status"] == "rejected":
            rejected.setdefault(c["album_id"], set()).add(c["product_url"])
        elif c["status"] in ("accepted", "auto") and c["data"]:
            # an accepted choice beats an automatic one
            if c["status"] == "accepted" or c["album_id"] not in decided:
                decided[c["album_id"]] = json.loads(c["data"])
    pending = {r[0] for r in conn.execute("SELECT DISTINCT album_id FROM cover_candidates "
                                          "WHERE status='pending' AND album_id LIKE 'ab%'")}
    todo = [b for b in books if b["id"] in decided
            or (b["id"] not in pending and (not b["has_cover"] or not b["description"] or not b["subtitle"]))]
    if not todo:
        return stats
    st.phase, st.total, st.done = "book-details", len(todo), 0
    st.emit(f"Cerco online copertine e dettagli di {len(todo)} audiolibri…")
    cache = Cache()
    try:
        for b in todo:
            st.done += 1
            bid = b["id"]
            if bid in decided:
                apply(conn, bid, Result.from_json(decided[bid]))
                stats.reused += 1
                continue
            try:
                results = [r for r in search(cache, b["title"], b["subtitle"], b["language"])
                           if r.url not in rejected.get(bid, set())]
            except Exception as e:
                stats.failed.append(b["title"])
                log.info("lookup failed for %s: %s", b["title"], e)
                continue
            for r in results[:3]:
                v = verdict(*score(r, b["title"], b["subtitle"]))
                if not v:
                    continue
                complete(cache, r)
                img = image_file(r.image_url) if r.image_url and settings.online_covers else None
                if v == "auto":
                    store_candidate(conn, bid, r, "auto", img)
                    filled = apply(conn, bid, r)
                    issue(bid, None, "info", "online_details",
                          f"Dettagli da {SOURCE_NAME[r.source]}: «{r.title}»"
                          + (f" ({', '.join(filled)})" if filled else ""))
                    stats.auto += 1
                elif img or r.description:
                    store_candidate(conn, bid, r, "pending", img)
                    stats.pending += 1
                break
    finally:
        cache.save()
    st.emit(f"Audiolibri online: {stats.auto} completati, {stats.pending} da verificare"
            + (f", {stats.reused} già confermati" if stats.reused else ""))
    return stats
