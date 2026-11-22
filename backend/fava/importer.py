"""Scan the asset folder, build the catalogue and verify every track.

Accepted inputs (anywhere below ``FAVA_ASSET_DIR``, any depth):

* ``K0010/CP01.MKI`` …   Faba box SD-card dump (``.MKI`` extension optional)
* ``0010 - Title/NN - Track title.mp3``  already decoded copies (optional)
* ``list.csv`` / ``list.txt``             ``id,title`` lines, UTF-8 or UTF-16
* ``K10 - Title - Documento|Testi|Attivita.pdf``  official booklets (optional)

Audiobooks (``audiobooks/`` or ``audiolibri/`` below the asset folder, uploads,
``FAVA_AUDIOBOOK_DIR``) are imported too: see audiobooks.py.
"""

from __future__ import annotations

import colorsys
import difflib
import io
import json
import logging
import os
import re
import statistics
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import audiobooks, bookinfo, catalog, db, mki, pdfmeta, registry
from .config import settings

log = logging.getLogger(__name__)

BOOKLET_CACHE_VERSION = 3  # bump when booklet parsing / cover extraction changes

RE_MKI_DIR = re.compile(r"^K(\d{4})$", re.I)
RE_MKI_FILE = re.compile(r"^CP(\d{1,3})(\.MKI)?$", re.I)
RE_MP3_DIR = re.compile(r"^(\d{4})\s*-\s*(.+)$")
RE_MP3_FILE = re.compile(r"^(\d{1,3}|ZZ)\s*-\s*(.+)\.mp3$", re.I)
RE_PDF = re.compile(r"^([KG])(\d{1,4})\s*-\s*(.+?)\s*-\s*(Documento|Testi|Attivita|Attività)\.pdf$", re.I)
RE_GENERIC_TRACK = re.compile(r"^(traccia|track|piste|pista|titre)\s*\d+$", re.I)
RE_EXTRA = re.compile(r"^(intro|outro)\s+faba$", re.I)

CATEGORY_TITLE_HINTS = [
    ("rhymes", ("filastrocche", "comptines", "nursery")),
    ("music", ("canzoni", "canta", "musica", "music", "chansons", "canciones", "cançons", "song",
               "sing", "jazz", "rock", "sinfonie", "symphon", "piano", "musique", "música",
               "coccole musicali", "balla", "baile", "comptines")),
    ("stories", ("storie", "fiabe", "racconti", "avventure", "histoires", "contes", "cuentos",
                 "stories", "conte", "cuento", "favole", "aventuras", "aventures", "adventures",
                 "historias", "libro", "livre")),
]


# --------------------------------------------------------------------------- state

@dataclass
class ImportState:
    running: bool = False
    phase: str = "idle"
    done: int = 0
    total: int = 0
    started_at: float | None = None
    finished_at: float | None = None
    message: str = ""
    log: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def emit(self, msg: str) -> None:
        log.info(msg)
        self.message = msg
        self.log.append(time.strftime("%H:%M:%S ") + msg)
        del self.log[:-300]


state = ImportState()
_lock = threading.Lock()

# old track id -> new track id after the last import: players still holding the old
# ids keep streaming and saving their position (see main.resolve_track)
track_remap: dict[int, int] = {}


# --------------------------------------------------------------------------- scan

@dataclass
class AlbumSrc:
    id: str
    mki: dict[int, Path] = field(default_factory=dict)
    mp3_dir: Path | None = None
    mp3_title: str | None = None
    mp3: list[Path] = field(default_factory=list)
    csv_title: str | None = None
    pdfs: dict[str, Path] = field(default_factory=dict)       # kind -> path
    pdf_title: str | None = None


def _read_list(path: Path) -> dict[str, str]:
    raw = path.read_bytes()
    for enc in ("utf-16", "utf-8-sig", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeError:
            continue
    out = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(\d{4})\s*[,;]\s*(.+?)\s*$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def scan(root: Path) -> dict[str, AlbumSrc]:
    albums: dict[str, AlbumSrc] = {}

    def get(fid: str) -> AlbumSrc:
        return albums.setdefault(fid, AlbumSrc(fid))

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        d = Path(dirpath)
        if d == root:  # audiobooks have their own importer
            dirnames[:] = [x for x in dirnames if x.lower() not in audiobooks.ROOT_DIR_NAMES]
        m = RE_MKI_DIR.match(d.name)
        if m:
            for f in filenames:
                fm = RE_MKI_FILE.match(f)
                if fm:
                    get(m.group(1)).mki[int(fm.group(1))] = d / f
            continue
        m = RE_MP3_DIR.match(d.name)
        if m and any(f.lower().endswith(".mp3") for f in filenames):
            a = get(m.group(1))
            a.mp3_dir, a.mp3_title = d, m.group(2).strip()
            a.mp3 = sorted((d / f for f in filenames if f.lower().endswith(".mp3")),
                           key=lambda p: p.name.upper())
            continue
        for f in filenames:
            lf = f.lower()
            if lf in ("list.csv", "list.txt"):
                for fid, title in _read_list(d / f).items():
                    get(fid).csv_title = title
            elif lf.endswith(".pdf"):
                pm = RE_PDF.match(f)
                if pm and pm.group(1).upper() == "K":
                    fid = pm.group(2).zfill(4)
                    kind = pm.group(4).replace("à", "a").capitalize()
                    a = get(fid)
                    a.pdfs[kind] = d / f
                    a.pdf_title = a.pdf_title or pm.group(3)
    return albums


# --------------------------------------------------------------------------- helpers

def _stamp(p: Path) -> str:
    st = p.stat()
    return f"{st.st_size}:{int(st.st_mtime)}"


def _cached(conn, path: Path, fn):
    stamp = _stamp(path)
    row = conn.execute("SELECT stamp, data FROM file_cache WHERE path=?", (str(path),)).fetchone()
    if row and row["stamp"] == stamp:
        return json.loads(row["data"])
    data = fn()
    conn.execute("INSERT OR REPLACE INTO file_cache(path, stamp, data) VALUES(?,?,?)",
                 (str(path), stamp, json.dumps(data, ensure_ascii=False)))
    return data


def probe_audio(path: Path, kind: str) -> dict:
    """Duration/bitrate plus a sanity check of the (decoded) MPEG stream."""
    from mutagen.mp3 import MP3

    info: dict = {"size": path.stat().st_size, "valid": False}
    try:
        if kind == "mki":
            with open(path, "rb") as fh:
                head = mki.decode(fh.read(4))
            reader = mki.DecodingReader(path)
            try:
                audio = MP3(fileobj=io.BufferedReader(reader))
            finally:
                reader.close()
        else:
            with open(path, "rb") as fh:
                head = fh.read(4)
            audio = MP3(str(path))
        info["header_ok"] = head[:3] == b"ID3" or (head[0] == 0xFF and head[1] & 0xE0 == 0xE0)
        info["duration"] = round(float(audio.info.length), 2)
        info["bitrate"] = int(audio.info.bitrate or 0)
        info["valid"] = bool(info["header_ok"] and info["duration"] > 0)
        title = None
        if audio.tags is not None and "TIT2" in audio.tags:
            title = str(audio.tags["TIT2"]).strip() or None
        info["tag_title"] = title
    except Exception as e:
        info["error"] = str(e)
    return info


def _audio_end(read_at, size: int) -> int:
    """Offset where audio ends (excludes a trailing ID3v1 tag)."""
    if size >= 128 and read_at(size - 128, 3) == b"TAG":
        return size - 128
    return size


def _cached_key(conn, key: str, path: Path, fn):
    """Like _cached, but several derived values per file (key = path#name)."""
    stamp = _stamp(path)
    row = conn.execute("SELECT stamp, data FROM file_cache WHERE path=?", (key,)).fetchone()
    if row and row["stamp"] == stamp:
        return json.loads(row["data"])
    data = fn()
    conn.execute("INSERT OR REPLACE INTO file_cache(path, stamp, data) VALUES(?,?,?)",
                 (key, stamp, json.dumps(data)))
    return data


def file_md5(conn, path: Path) -> str:
    import hashlib
    return _cached_key(conn, f"{path}#md5", path, lambda: hashlib.md5(path.read_bytes()).hexdigest())


def audio_fingerprint(conn, path: Path, kind: str) -> str:
    """Size + hash of a window in the middle of the decoded audio.

    Ignores ID3 tags (which carry the KxxxxCPyy id), so the same recording
    sold with figures in different languages gets the same fingerprint.
    """
    import hashlib

    def fp():
        size = path.stat().st_size
        off = max(0, size // 2 - 32768)
        with open(path, "rb") as fh:
            fh.seek(off)
            buf = fh.read(65536)
        if kind == "mki":
            buf = mki.decode(buf, off)
        return f"{size}:{hashlib.md5(buf).hexdigest()[:16]}"
    return _cached_key(conn, f"{path}#fp", path, fp)


def compare_copies(mki_path: Path, mp3_path: Path, n: int) -> bool:
    """Compare the audio of an MKI with its MP3 copy.

    ID3 tags (v2 at the start, v1 in the last 128 bytes) legitimately differ
    because tools rewrite titles, so only the audio tail is compared.
    """
    s1, s2 = mki_path.stat().st_size, mp3_path.stat().st_size
    with open(mki_path, "rb") as a, open(mp3_path, "rb") as b:
        def ra(off, k):
            a.seek(off)
            return mki.decode(a.read(k), off)

        def rb(off, k):
            b.seek(off)
            return b.read(k)

        e1, e2 = _audio_end(ra, s1), _audio_end(rb, s2)
        k = min(n, e1 // 2, e2 // 2)
        if k <= 0:
            return True
        return ra(e1 - k, k) == rb(e2 - k, k)


def _mp3_track_title(p: Path) -> str | None:
    m = RE_MP3_FILE.match(p.name)
    title = (m.group(2) if m else p.stem).strip()
    if RE_GENERIC_TRACK.match(title):
        return None
    return title


_STOP = {"il", "lo", "la", "le", "i", "gli", "di", "del", "della", "e", "a", "the", "of", "and",
          "el", "los", "las", "y", "de", "les", "des", "et", "du", "un", "una", "une", "con", "avec"}


def _words(s: str) -> set[str]:
    import unicodedata
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return {w for w in re.findall(r"[a-z0-9]+", s) if w not in _STOP}


def _similar(a: str | None, b: str | None) -> float:
    """Blend of character similarity and word overlap (0..1)."""
    if not a or not b:
        return 0.0
    chars = difflib.SequenceMatcher(None, pdfmeta.norm_title(a), pdfmeta.norm_title(b)).ratio()
    wa, wb = _words(a), _words(b)
    jacc = len(wa & wb) / len(wa | wb) if wa and wb else chars
    return (chars + jacc) / 2


def _smart_title(s: str) -> str:
    """Booklet titles are ALL CAPS – make them readable."""
    if s.upper() != s:
        return s
    s = s.lower()
    return s[:1].upper() + s[1:]


def _series(title: str) -> str | None:
    m = re.match(r"^(.{2,30}?)\s+[-–:]\s+.+$", title)
    if m and len(m.group(1).split()) <= 4:
        return m.group(1).strip()
    return None


_LANG_WORDS = {
    "it": {"il", "lo", "gli", "della", "delle", "di", "e", "nella", "con", "che", "più", "un", "una",
           "storia", "storie", "canzoni", "dei", "del", "per", "alla", "nel"},
    "fr": {"le", "les", "des", "et", "du", "pour", "avec", "une", "histoire", "histoires", "chansons",
           "au", "aux", "dans", "est", "petit", "petits"},
    "es": {"el", "los", "las", "y", "con", "otro", "cuento", "cuentos", "canciones", "una", "del",
           "para", "por", "en", "al"},
    "ca": {"i", "els", "les", "amb", "conte", "contes", "cançons", "per"},
    "en": {"the", "and", "with", "of", "song", "songs", "story", "stories", "sing", "to", "my"},
}


def _guess_lang(texts: list[str]) -> str | None:
    score: dict[str, int] = defaultdict(int)
    for t in texts:
        for w in re.findall(r"[a-zàâçéèêëîïôûùüÿñæœ']+", t.lower()):
            for lang, words in _LANG_WORDS.items():
                if w in words:
                    score[lang] += 1
    if not score:
        return None
    best = max(score, key=score.get)
    return best if score[best] >= 2 else None


def _category_from_title(title: str) -> str | None:
    t = title.lower()
    for cat, keys in CATEGORY_TITLE_HINTS:
        if any(k in t for k in keys):
            return cat
    return None


def _cover_color(png: bytes, figure: bool = True) -> str | None:
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(png)).convert("RGBA")
        if figure:  # ignore the red plastic base every Faba figure stands on
            img = img.crop((0, 0, img.width, int(img.height * 0.78)))
        img.thumbnail((64, 64))
        px = [p for p in img.getdata() if p[3] > 200]
        if not px:
            return None
        # pick the most saturated frequent colour bucket
        buckets: dict[tuple, list] = defaultdict(list)
        for r, g, b, _ in px:
            buckets[(r // 32, g // 32, b // 32)].append((r, g, b))
        best, score = None, -1.0
        for items in buckets.values():
            r = sum(i[0] for i in items) / len(items)
            g = sum(i[1] for i in items) / len(items)
            b = sum(i[2] for i in items) / len(items)
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            sc = len(items) * (0.25 + s) * (1 - abs(l - 0.5))
            if sc > score:
                best, score = (h, l, s), sc
        h, l, s = best
        r, g, b = colorsys.hls_to_rgb(h, min(max(l, 0.35), 0.5), min(1.0, s * 1.1 + 0.1))
        return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))
    except Exception:
        return None


# --------------------------------------------------------------------------- covers

RE_MANUAL_COVER = re.compile(r"^K?(\d{4})\.(png|jpe?g|webp)$", re.I)


def _set_cover(conn, fid: str, png_path: Path, source: str) -> None:
    png = png_path.read_bytes()
    (settings.covers_dir / f"{fid}.png").write_bytes(png)
    conn.execute("UPDATE albums SET has_cover=1, cover_source=?, color=? WHERE id=?",
                 (source, _cover_color(png), fid))


def _upsert_candidate(conn, fid, source, url, name, image: Path, score, status) -> None:
    conn.execute(
        "INSERT INTO cover_candidates(album_id, source, product_url, product_name, image, score, status) "
        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(album_id, product_url) DO UPDATE SET "
        "product_name=excluded.product_name, image=excluded.image, score=excluded.score",
        (fid, source, url, name, image.name, score, status))


def _link(conn, fid: str, source: str, url: str, method: str) -> None:
    conn.execute("INSERT INTO album_links(album_id, source, url, method) VALUES(?,?,?,?) "
                 "ON CONFLICT(album_id) DO UPDATE SET source=excluded.source, url=excluded.url, "
                 "method=excluded.method", (fid, source, url, method))


def _covers_phase(conn, st: ImportState, reg, srcs, issue) -> None:
    img_dir = settings.data_dir / "catalog" / "img"

    # 1. manual covers: asset/covers/K0010.png (always win)
    from PIL import Image
    known = {r[0] for r in conn.execute("SELECT id FROM albums")}
    for manual in (settings.asset_dir / "covers", settings.data_dir / "covers-manual"):
        if not manual.is_dir():
            continue
        for f in sorted(manual.iterdir()):
            m = RE_MANUAL_COVER.match(f.name)
            if not m or m.group(1) not in known:
                continue
            try:
                img = Image.open(f).convert("RGBA")
                img.thumbnail((640, 640))
                buf = io.BytesIO()
                img.save(buf, "PNG", optimize=True)
                out = settings.covers_dir / f"manual-{m.group(1)}.png"
                out.write_bytes(buf.getvalue())
                _set_cover(conn, m.group(1), out, "manual")
            except Exception as e:
                issue(m.group(1), None, "warning", "manual_cover", f"Copertina {f.name} non leggibile: {e}")

    # 2. candidates reviewed earlier (accepted, or applied automatically and not undone)
    for row in conn.execute(
            "SELECT c.album_id, c.image, c.source, c.product_url FROM cover_candidates c "
            "JOIN albums a ON a.id=c.album_id "
            "WHERE a.has_cover=0 AND c.status='accepted' AND a.kind='faba'").fetchall():  # automatic ones are re-found
        p = img_dir / row["image"]
        has = conn.execute("SELECT has_cover FROM albums WHERE id=?", (row["album_id"],)).fetchone()[0]
        if p.exists() and not has:
            _set_cover(conn, row["album_id"], p, "catalog" if row["source"] == "myfaba" else "retailer")
            _link(conn, row["album_id"], row["source"], row["product_url"], "review")

    if not settings.online_covers:
        return
    rejected: dict[str, set] = defaultdict(set)
    for r in conn.execute("SELECT album_id, product_url FROM cover_candidates WHERE status='rejected'"):
        rejected[r[0]].add(r[1])
    pending = {r[0] for r in conn.execute("SELECT album_id FROM cover_candidates WHERE status='pending'")}

    def names_for(row):
        fid = row["id"]
        return [row["title"], reg[fid].name if fid in reg else None,
                srcs[fid].pdf_title if fid in srcs else None]

    # 3. official catalogue
    todo = conn.execute("SELECT id, title, language, sku FROM albums WHERE has_cover=0 AND kind='faba' "
                        "ORDER BY sku IS NULL, id").fetchall()  # SKU matches first
    if todo:
        st.phase, st.total, st.done = "covers", len(todo), 0
        st.emit(f"Cerco {len(todo)} copertine mancanti nel catalogo ufficiale…")
        found = 0
        try:
            finder = catalog.Finder()
            for row in todo:
                st.done += 1
                fid = row["id"]
                m = finder.find(names_for(row), row["sku"], row["language"], rejected[fid])
                if not m:
                    continue
                _set_cover(conn, fid, m.image, "catalog")
                _link(conn, fid, "myfaba", m.product_url, m.method)
                if m.method == "title":  # reviewable, can be undone from the UI
                    _upsert_candidate(conn, fid, "myfaba", m.product_url, m.product_name, m.image, None, "auto")
                issue(fid, None, "info", "catalog_cover",
                      f"Copertina dal catalogo ufficiale ({'SKU' if m.method == 'sku' else 'titolo'}): "
                      f"«{m.product_name}»")
                found += 1
                if found % 10 == 0:
                    finder.close()  # persist the page cache
            finder.close()
        except Exception as e:  # network problems must not break the import
            log.warning("catalog lookup failed: %s", e)
        st.emit(f"Copertine dal catalogo ufficiale: {found}/{len(todo)}")

    # 4. retailers (retired figures)
    todo = conn.execute("SELECT id, title, language, sku FROM albums WHERE has_cover=0 AND kind='faba' "
                        "ORDER BY id").fetchall()
    todo = [r for r in todo if r["id"] not in pending]
    if todo and settings.retailer_sitemaps:
        st.total, st.done = len(todo), 0
        st.emit(f"Cerco {len(todo)} copertine presso i rivenditori…")
        auto = sugg = 0
        try:
            library = {r[0]: r[1] for r in conn.execute("SELECT id, title FROM albums WHERE kind='faba'")}
            rf = catalog.RetailerFinder(library)
            for row in todo:
                st.done += 1
                fid = row["id"]
                c = rf.find(fid, names_for(row), rejected[fid])
                if not c:
                    continue
                if c.certain:
                    _set_cover(conn, fid, c.image, "retailer")
                    _link(conn, fid, c.source, c.product_url, "title")
                    _upsert_candidate(conn, fid, c.source, c.product_url, c.product_name, c.image, c.score, "auto")
                    auto += 1
                else:
                    _upsert_candidate(conn, fid, c.source, c.product_url, c.product_name, c.image, c.score,
                                      "pending")
                    sugg += 1
        except Exception as e:
            log.warning("retailer lookup failed: %s", e)
        st.emit(f"Rivenditori: {auto} copertine applicate, {sugg} da verificare")


def _details_phase(conn, st: ImportState, reg, srcs, issue) -> None:
    """Description, age and contents from the linked product page; track titles
    when the product lists exactly one title per track."""
    rejected: dict[str, set] = defaultdict(set)
    for r in conn.execute("SELECT album_id, product_url FROM cover_candidates WHERE status='rejected'"):
        rejected[r[0]].add(r[1])
    # forget links the user rejected through the cover review
    for fid, urls in rejected.items():
        for u in urls:
            conn.execute("DELETE FROM album_links WHERE album_id=? AND url=?", (fid, u))

    # 1. link albums that got their cover elsewhere (booklet, manual) to the catalogue
    todo = conn.execute("SELECT id, title, language, sku FROM albums WHERE kind='faba' AND id NOT IN "
                        "(SELECT album_id FROM album_links) ORDER BY sku IS NULL, id").fetchall()
    if todo:
        st.phase, st.total, st.done = "details", len(todo), 0
        st.emit(f"Collego {len(todo)} album al catalogo ufficiale…")
        try:
            finder = catalog.Finder()
            # products already linked count as claimed (same rules as covers)
            for r in conn.execute("SELECT l.url, a.language FROM album_links l JOIN albums a ON a.id=l.album_id"):
                finder.claimed.setdefault(r[0], set()).add(r[1])
            for row in todo:
                st.done += 1
                fid = row["id"]
                names = [row["title"], reg[fid].name if fid in reg else None,
                         srcs[fid].pdf_title if fid in srcs else None]
                m = finder.find(names, row["sku"], row["language"], rejected[fid], with_image=False)
                if m:
                    _link(conn, fid, "myfaba", m.product_url, m.method)
            finder.close()
        except Exception as e:
            log.warning("catalog linking failed: %s", e)

    # 2. read product pages
    links = conn.execute("SELECT album_id, source, url, method FROM album_links ORDER BY album_id").fetchall()
    if not links:
        return
    st.phase, st.total, st.done = "details", len(links), 0
    st.emit(f"Leggo descrizioni e contenuti di {len(links)} album…")
    cache = catalog.DetailsCache()
    titled = 0
    try:
        for i, ln in enumerate(links):
            st.done += 1
            fid = ln["album_id"]
            info = cache.get(ln["url"])
            if (i + 1) % 10 == 0:
                cache.save()
            sections = [s for s in info.get("sections", []) if s.get("items")]
            conn.execute("UPDATE albums SET description=?, age=?, contents=?, product_url=? WHERE id=?",
                         (info.get("description"), info.get("age"),
                          json.dumps(sections, ensure_ascii=False) if sections else None, ln["url"], fid))
            text = " ".join([info.get("description") or ""] + [i for s in sections for i in s["items"]])
            if text.strip():
                conn.execute("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)",
                             (fid, None, "info", text))
            # track titles: only when the mapping is unambiguous
            tracks = conn.execute("SELECT id, idx, title_source, duration FROM tracks WHERE album_id=? "
                                  "AND is_extra=0 ORDER BY idx", (fid,)).fetchall()
            if not tracks or not any(t["title_source"] == "generic" for t in tracks):
                continue
            items = [re.sub(r"\s*\.\.\.$", "…", i) for s in sections for i in s["items"]]
            # undetected Faba jingles: short extra tracks at the start / end
            extra = len(tracks) - len(items)
            if items and extra in (1, 2) and len(items) > 1:
                ends = [tracks[0]] + ([tracks[-1]] if extra == 2 else [])
                if all((t["duration"] or 0) < 45 for t in ends):
                    for t in ends:
                        conn.execute("UPDATE tracks SET is_extra=1, title=?, title_source='detected' WHERE id=?",
                                     ("Intro Faba" if t is tracks[0] else "Outro Faba", t["id"]))
                    tracks = tracks[1:len(tracks) - (1 if extra == 2 else 0)]
            names: list[str] | None = None
            if len({catalog._norm(i) for i in items}) < len(items):
                continue  # repeated entries: a content summary, not a tracklist
            if len(items) == len(tracks):
                names = items
            elif len(items) == 1 and len(tracks) > 1:
                names = [f"{items[0]} · parte {n}" for n in range(1, len(tracks) + 1)]
            if not names:
                continue
            for t, name in zip(tracks, names):
                if t["title_source"] != "generic":
                    continue
                conn.execute("UPDATE tracks SET title=?, title_source='catalog' WHERE id=?", (name, t["id"]))
                conn.execute("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)",
                             (fid, t["id"], "track", name))
                titled += 1
    except Exception as e:
        log.warning("details lookup failed: %s", e)
    finally:
        cache.save()
    st.emit(f"Dettagli online: {sum(1 for _ in links)} album, {titled} titoli di traccia aggiunti")


# --------------------------------------------------------------------------- audiobooks

def _write_cover(data: bytes | None, target: Path) -> bool:
    png = audiobooks.to_png(data) if data else None
    if not png:
        return False
    target.write_bytes(png)
    return True


def _audiobooks_phase(conn, st: ImportState, existing: set, issue) -> int:
    probes: dict[str, dict] = {}

    def probe_cached(p: Path) -> dict:
        k = str(p)
        if k not in probes:
            key = f"{p}#ab"
            d = _cached_key(conn, key, p, lambda: audiobooks.probe(p))
            if d.get("v") != audiobooks.PROBE_VERSION:
                conn.execute("DELETE FROM file_cache WHERE path=?", (key,))
                d = _cached_key(conn, key, p, lambda: audiobooks.probe(p))
            probes[k] = d
        return probes[k]

    st.emit("Cerco audiolibri…")
    books = audiobooks.scan(probe_cached)
    if not books:
        return 0
    st.phase, st.total, st.done = "audiobooks", len(books), 0
    st.emit(f"Audiolibri: {len(books)} trovati, lettura capitoli e copertine…")
    overrides = {r[0]: r[1] for r in conn.execute("SELECT album_id, audience FROM album_overrides")}
    manual_dir = settings.data_dir / "covers-manual"
    for book in books:
        st.done += 1
        infos = [probe_cached(p) for p in book.files]
        idx = list(range(len(book.files)))
        if len(idx) > 1 and all(i.get("track") for i in infos):
            idx.sort(key=lambda i: (infos[i].get("disc") or 0, infos[i]["track"]))
        files, infos = [book.files[i] for i in idx], [infos[i] for i in idx]
        meta = audiobooks.describe(book, infos)
        lang = meta["language"] or _guess_lang([meta["title"], meta.get("description") or ""])
        audience = overrides.get(book.id) or audiobooks.detect_audience(book, meta["genre"])

        # cover: uploaded from the UI > embedded in the file > image in the folder
        target = settings.covers_dir / f"{book.id}.png"
        csrc = None
        manual = manual_dir / f"{book.id}.png"
        if manual.is_file():
            target.write_bytes(manual.read_bytes())
            csrc = "manual"
        if not csrc:
            src = next((p for p, i in zip(files, infos) if i.get("has_cover")), None)
            if src:
                ck = f"{src}#abcover:{book.id}"

                def extract(src=src):
                    return {"ok": _write_cover(audiobooks.embedded_cover(src), target)}
                got = _cached_key(conn, ck, src, extract)
                if got.get("ok") and not target.exists():
                    conn.execute("DELETE FROM file_cache WHERE path=?", (ck,))
                    got = _cached_key(conn, ck, src, extract)
                csrc = "tag" if got.get("ok") else None
        if not csrc:
            fc = audiobooks.folder_cover(book.folder)
            if fc and _write_cover(fc.read_bytes(), target):
                csrc = "folder"
        color = _cover_color(target.read_bytes(), figure=False) if csrc else None

        single = len(files) == 1
        tracks = []
        for n, (p, info) in enumerate(zip(files, infos), start=1):
            title, tsrc = audiobooks.track_title(p, info, meta["title"], single)
            if not info.get("valid"):
                issue(book.id, n, "error", "invalid_audio",
                      f"«{p.name}» non riproducibile: {info.get('error') or 'durata nulla'}")
            tracks.append((n, title, tsrc, info, p))
        total = sum(t[3].get("duration") or 0 for t in tracks)
        if single and not infos[0].get("chapters") and total > 3600:
            issue(book.id, None, "info", "no_chapters", "Il file non contiene capitoli")

        row = dict(id=book.id, kind="audiobook", audience=audience, title=meta["title"],
                   title_source=meta["title_source"], subtitle=meta["author"],
                   category="audiobook", category_source="audiobook", language=lang, series=None, sku=None,
                   track_count=len(tracks), duration=round(total, 1),
                   has_cover=int(bool(csrc)), cover_source=csrc, color=color,
                   credits=audiobooks.credits(meta), has_lyrics=0,
                   sources=json.dumps(sorted({p.suffix.lower()[1:] for p in files})),
                   description=meta["description"], age=None, contents=None, product_url=None,
                   duplicate_of=None, online_fields=None)
        conn.execute(
            f"INSERT INTO albums({', '.join(row)}) VALUES({', '.join('?' * len(row))}) "
            f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{k}=excluded.{k}' for k in row if k != 'id')}",
            tuple(row.values()))
        existing.discard(book.id)

        search_rows = [(book.id, None, "album", meta["title"])]
        names = " ".join(x for x in (meta["author"], meta["narrator"]) if x)
        if names:
            search_rows.append((book.id, None, "credit", names))
        if meta["description"]:
            search_rows.append((book.id, None, "info", meta["description"]))
        for n, title, tsrc, info, p in tracks:
            chapters = info.get("chapters") or []
            cur = conn.execute(
                "INSERT INTO tracks(album_id, idx, title, title_source, duration, bitrate, size, "
                "source_kind, source_path, is_extra, valid, chapters) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)",
                (book.id, n, title, tsrc, info.get("duration") or 0, info.get("bitrate"), info.get("size"),
                 p.suffix.lower()[1:], str(p), int(bool(info.get("valid"))),
                 json.dumps(chapters, ensure_ascii=False) if chapters else None))
            if tsrc != "book" and not audiobooks.is_generic(title):
                search_rows.append((book.id, cur.lastrowid, "track", title))
        conn.executemany("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)", search_rows)
    st.emit(f"Audiolibri importati: {len(books)}")
    return len(books)


# --------------------------------------------------------------------------- import

def run_import() -> None:
    if not _lock.acquire(blocking=False):
        return
    try:
        _run()
    except Exception as e:  # pragma: no cover
        log.exception("import failed")
        state.emit(f"Errore: {e}")
        state.phase = "error"
    finally:
        state.running = False
        state.finished_at = time.time()
        _lock.release()


def start_background() -> bool:
    if state.running:
        return False
    state.running = True
    state.log.clear()
    threading.Thread(target=run_import, daemon=True, name="fava-import").start()
    return True


def _run() -> None:
    st = state
    st.running, st.started_at, st.finished_at = True, time.time(), None
    st.phase, st.done, st.total = "scan", 0, 0
    root = settings.asset_dir
    st.emit(f"Scansione di {root}")
    if root.exists():
        srcs = scan(root)
    else:
        st.emit("Cartella asset non trovata")
        srcs = {}
    up = settings.data_dir / "uploads"
    if up.is_dir():
        for fid, a in scan(up).items():  # uploaded backups complete / extend the asset folder
            b = srcs.setdefault(fid, AlbumSrc(fid))
            b.mki.update(a.mki)
            if a.mp3 and not b.mp3:
                b.mp3_dir, b.mp3_title, b.mp3 = a.mp3_dir, a.mp3_title, a.mp3
            b.csv_title = b.csv_title or a.csv_title
            for kind, path in a.pdfs.items():
                b.pdfs.setdefault(kind, path)
            b.pdf_title = b.pdf_title or a.pdf_title
    srcs = {k: v for k, v in srcs.items() if v.mki or v.mp3}
    st.emit(f"Trovati {len(srcs)} album "
            f"({sum(len(a.mki) for a in srcs.values())} file MKI, "
            f"{sum(len(a.mp3) for a in srcs.values())} MP3, "
            f"{sum(len(a.pdfs) for a in srcs.values())} PDF)")

    st.phase = "registry"
    reg = registry.load()
    if reg:
        st.emit(f"Registro figure: {len(reg)} voci")

    settings.covers_dir.mkdir(parents=True, exist_ok=True)
    st.phase = "albums"
    st.total = len(srcs)

    booklets: dict[str, dict[str, dict]] = {}
    with db.session() as conn:
        # ---- parse booklets first (needed to detect mislabelled PDFs)
        st.emit("Lettura libretti PDF…")
        for i, (fid, a) in enumerate(sorted(srcs.items())):
            st.done = i
            for kind, path in a.pdfs.items():
                if kind == "Attivita":
                    continue

                def parse(path=path, kind=kind):
                    b = pdfmeta.parse_booklet(path, kind, want_cover=settings.extract_covers)
                    cover = None
                    if b.cover_png:
                        cover = f"pdf-{abs(hash(str(path))) % 10**10}.png"
                        (settings.covers_dir / cover).write_bytes(b.cover_png)
                    return {"v": BOOKLET_CACHE_VERSION, "subtitle": b.subtitle, "category": b.category, "language": b.language,
                            "title": b.title, "credits": b.credits,
                            "tracklist": {str(k): v for k, v in b.tracklist.items()},
                            "lyrics": b.lyrics, "cover": cover}
                data = _cached(conn, path, parse)
                if data.get("v") != BOOKLET_CACHE_VERSION or (
                        data.get("cover") and not (settings.covers_dir / data["cover"]).exists()):
                    conn.execute("DELETE FROM file_cache WHERE path=?", (str(path),))
                    data = _cached(conn, path, parse)
                booklets.setdefault(fid, {})[kind] = data

        conn.execute("DELETE FROM issues")
        conn.execute("DELETE FROM search")
        conn.execute("DELETE FROM documents")
        old_tracks = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT id, album_id, idx FROM tracks")}
        conn.execute("DELETE FROM tracks")
        existing = {r["id"] for r in conn.execute("SELECT id FROM albums")}

        issues: list[tuple] = []

        def issue(fid, idx, level, code, msg):
            issues.append((fid, idx, level, code, msg))

        # ---- base titles (before booklet reassignment)
        base_title = {}
        for fid, a in srcs.items():
            base_title[fid] = a.mp3_title or a.csv_title or (reg[fid].name if fid in reg else None) \
                or a.pdf_title

        # ---- identical booklet files filed under several figures: only the album whose
        #      title matches the booklet keeps it (activity sheets are legitimately shared)
        groups: dict[tuple, list[str]] = defaultdict(list)
        for fid, a in srcs.items():
            for kind, path in a.pdfs.items():
                if kind != "Attivita":
                    groups[(kind, file_md5(conn, path))].append(fid)
        for (kind, _h), fids in groups.items():
            if len(fids) < 2:
                continue
            btitle = next((booklets.get(f, {}).get(kind, {}).get("title") for f in fids
                           if booklets.get(f, {}).get(kind, {}).get("title")), None)
            if not btitle:
                continue

            def score(f):
                return max(_similar(btitle, base_title.get(f)),
                           _similar(btitle, reg[f].name) if f in reg else 0)
            scores = {f: score(f) for f in fids}
            best = max(scores.values())
            keep = {f for f, s in scores.items() if s >= 0.75 and s >= best - 0.05}
            owner = max(scores, key=scores.get)
            second = max((s for f, s in scores.items() if f != owner), default=0)
            if not keep and best >= 0.5 and best - second >= 0.1:
                keep = {owner}  # clear winner even if the booklet title is shorter/longer
            for f in fids:
                if f in keep:
                    continue
                name = srcs[f].pdfs[kind].name
                ref = f"dell'album {owner}" if owner in keep else "di un altro album"
                issue(f, None, "warning", "pdf_duplicate",
                      f"Il PDF «{name}» è una copia identica di quello {ref} "
                      f"(contiene «{_smart_title(btitle)}»): ignorato.")
                booklets.get(f, {}).pop(kind, None)
                srcs[f].pdfs.pop(kind, None)

        # ---- detect booklets whose content belongs to another figure
        reassigned: dict[str, dict[str, tuple[dict, Path]]] = defaultdict(dict)
        for fid, kinds in list(booklets.items()):
            for kind, data in list(kinds.items()):
                btitle = data.get("title")
                if not btitle or not base_title.get(fid):
                    continue
                own = max(_similar(btitle, base_title[fid]),
                          _similar(btitle, reg[fid].name) if fid in reg else 0)
                if own >= 0.75:
                    continue
                best_id, best = None, 0.0
                for oid, t in base_title.items():
                    s = _similar(btitle, t)
                    if s > best:
                        best_id, best = oid, s
                if best_id and best_id != fid and best >= 0.8 and best - own >= 0.2:
                    issue(fid, None, "warning", "pdf_mismatch",
                          f"Il PDF «{srcs[fid].pdfs[kind].name}» contiene «{_smart_title(btitle)}», "
                          f"che corrisponde all'album {best_id}: spostato.")
                    if kind not in booklets.get(best_id, {}):
                        reassigned[best_id][kind] = (data, srcs[fid].pdfs[kind])
                    del kinds[kind]
                    srcs[fid].pdfs.pop(kind, None)
                elif own < 0.35:
                    issue(fid, None, "info", "pdf_title",
                          f"Titolo nel PDF «{_smart_title(btitle)}» diverso da «{base_title[fid]}»")
        for fid, kinds in reassigned.items():
            for kind, (data, path) in kinds.items():
                booklets.setdefault(fid, {})[kind] = data
                srcs[fid].pdfs[kind] = path

        # ---- albums & tracks
        st.phase = "tracks"
        st.total = sum(max(len(a.mki), len(a.mp3)) for a in srcs.values())
        st.done = 0
        st.emit("Verifica tracce audio…")
        n_ok = n_bad = 0
        album_fp: dict[str, tuple] = {}
        for fid in sorted(srcs):
            a = srcs[fid]
            bk = booklets.get(fid, {})
            doc, testi = bk.get("Documento", {}), bk.get("Testi", {})
            r = reg.get(fid)

            # title
            if a.mp3_title:
                title, tsrc = a.mp3_title, "mp3"
            elif a.csv_title:
                title, tsrc = a.csv_title, "list"
            elif r:
                title, tsrc = r.name, "registry"
            elif a.pdf_title:
                title, tsrc = a.pdf_title, "pdf"
            elif doc.get("title") or testi.get("title"):
                title, tsrc = _smart_title(doc.get("title") or testi.get("title")), "booklet"
            else:
                title, tsrc = f"Figura {fid}", "id"
                issue(fid, None, "warning", "no_title", "Nessun titolo trovato")
            title = re.sub(r"\s*\[(it|fr|es|en|ca|de)\]\s*$", "", title, flags=re.I)

            # language
            # registry first: booklets in backups are sometimes another edition's file
            lang = (r.language if r else None) or doc.get("language") or testi.get("language")
            if not lang:
                lang = _guess_lang([title] + [_mp3_track_title(p) or "" for p in a.mp3])

            # tracks: pair MKI files and MP3 copies by position
            n = max(len(a.mki), len(a.mp3))
            mki_idx = sorted(a.mki)
            if mki_idx and mki_idx != list(range(1, len(mki_idx) + 1)):
                missing = sorted(set(range(1, max(mki_idx) + 1)) - set(mki_idx))
                if missing:
                    issue(fid, None, "error", "missing_tracks",
                          f"Mancano i file CP{', CP'.join('%02d' % m for m in missing)}")
                n = max(n, max(mki_idx))
            if a.mki and a.mp3 and len(a.mki) != len(a.mp3):
                issue(fid, None, "warning", "count_mismatch",
                      f"{len(a.mki)} file MKI ma {len(a.mp3)} MP3")

            booklet_titles = {int(k): v for k, v in (testi.get("tracklist") or {}).items()}
            tracks = []
            for idx in range(1, n + 1):
                st.done += 1
                mk = a.mki.get(idx)
                mp = a.mp3[idx - 1] if idx - 1 < len(a.mp3) else None
                if not mk and not mp:
                    continue
                use_mp3 = (settings.prefer == "mp3" and mp is not None) or mk is None
                src_kind = "mp3" if use_mp3 else "mki"
                src = mp if use_mp3 else mk
                alt = (mk if use_mp3 else mp)
                info = _cached(conn, src, lambda src=src, k=src_kind: probe_audio(src, k))
                if not info.get("valid"):
                    # fall back to the other copy if that one is fine
                    if alt is not None:
                        k2 = "mki" if src_kind == "mp3" else "mp3"
                        info2 = _cached(conn, alt, lambda: probe_audio(alt, k2))
                        if info2.get("valid"):
                            issue(fid, idx, "warning", "fallback",
                                  f"Traccia {idx}: file {src_kind.upper()} non valido, uso la copia {k2.upper()}")
                            src, alt, src_kind, info = alt, src, k2, info2
                if not info.get("valid"):
                    n_bad += 1
                    issue(fid, idx, "error", "invalid_audio",
                          f"Traccia {idx} ({src.name}) non riproducibile: {info.get('error', 'header MP3 non valido')}")
                else:
                    n_ok += 1
                if mk and mp:
                    if not compare_copies(mk, mp, settings.verify_bytes):
                        issue(fid, idx, "info", "copy_differs",
                              f"Traccia {idx}: l'MP3 «{mp.name}» non coincide con {mk.name}")
                ttitle, ttsrc = None, None
                if mp:
                    ttitle = _mp3_track_title(mp)
                    ttsrc = "mp3" if ttitle else None
                tracks.append(dict(idx=idx, src=src, kind=src_kind, alt=alt, info=info,
                                   title=ttitle, title_source=ttsrc))

            # intro / outro detection + booklet titles
            for t in tracks:
                if t["title"] and RE_EXTRA.match(t["title"]):
                    t["extra"] = True
            if booklet_titles and tracks:
                n_extra_known = sum(1 for t in tracks if t.get("extra"))
                offset = 0
                if any(t.get("extra") for t in tracks[:1]):
                    offset = 1
                elif not n_extra_known and len(tracks) - len(booklet_titles) in (1, 2):
                    first = tracks[0]["info"].get("duration") or 0
                    if first and first < 45:
                        offset = 1
                        tracks[0]["extra"] = True
                        tracks[0]["title"] = tracks[0]["title"] or "Intro Faba"
                    if len(tracks) - len(booklet_titles) - offset == 1:
                        last = tracks[-1]["info"].get("duration") or 0
                        if last and last < 45:
                            tracks[-1]["extra"] = True
                            tracks[-1]["title"] = tracks[-1]["title"] or "Outro Faba"
                for t in tracks:
                    bt = booklet_titles.get(t["idx"] - offset)
                    if bt and not t["title"] and not t.get("extra"):
                        t["title"], t["title_source"] = bt, "booklet"
            for t in tracks:
                if not t["title"]:
                    t["title"], t["title_source"] = f"Traccia {t['idx']}", "generic"
                elif not t["title_source"]:
                    t["title_source"] = "detected"

            fps = tuple(audio_fingerprint(conn, t["src"], t["kind"]) for t in tracks
                        if not t.get("extra") and t["info"].get("valid"))
            if len(fps) >= 2:
                album_fp[fid] = fps

            # lyrics
            lyr = testi.get("lyrics") or []
            has_lyrics = False
            for head, text in lyr:
                if not head or not text:
                    continue
                best, score = None, 0.0
                for t in tracks:
                    s = _similar(head, t["title"])
                    nh, nt = pdfmeta.norm_title(head), pdfmeta.norm_title(t["title"])
                    if nt and (nt in nh or nh in nt):
                        s = max(s, 0.9)
                    if s > score:
                        best, score = t, s
                if best and score >= 0.7:
                    best["lyrics"] = (best.get("lyrics", "") + "\n\n" + text).strip()
                    has_lyrics = True

            # category: the SKU digit is the most reliable signal
            # (FFR1… stories, FFR2… rhymes, FFR3… music, FFR4… learning)
            sku_cat = None
            if r and r.sku:
                m = re.match(r"^[A-Z]{3}(\d)", r.sku)
                sku_cat = {"1": "stories", "2": "rhymes", "3": "music", "4": "learning"}.get(
                    m.group(1)) if m else None
            cat = doc.get("category") or testi.get("category")
            csrc = "booklet" if cat else None
            if sku_cat and (sku_cat == "learning" or not cat):
                cat, csrc = sku_cat, "sku"
            if not cat:
                cat = _category_from_title(title)
                csrc = "title" if cat else None
            if not cat:
                durs = [t["info"].get("duration") or 0 for t in tracks if not t.get("extra")]
                if durs:
                    med = statistics.median(durs)
                    cat = "stories" if med > 300 else "music" if med < 210 else None
                    csrc = "duration" if cat else None
            cat = cat or "other"

            # cover
            cover_file = doc.get("cover")
            has_cover, color = 0, None
            target = settings.covers_dir / f"{fid}.png"
            cover_source = None
            if cover_file and (settings.covers_dir / cover_file).exists():
                png = (settings.covers_dir / cover_file).read_bytes()
                target.write_bytes(png)
                has_cover, color, cover_source = 1, _cover_color(png), "booklet"
            # (stale cover files are removed at the end, once the new catalogue is committed)

            sources = sorted({"mki" if a.mki else "", "mp3" if a.mp3 else "",
                              "pdf" if a.pdfs else ""} - {""})
            total = sum((t["info"].get("duration") or 0) for t in tracks)
            credits = doc.get("credits") or {}
            if not a.pdfs:
                issue(fid, None, "info", "no_booklet", "Nessun libretto PDF")

            row = dict(id=fid, title=title, title_source=tsrc,
                       subtitle=doc.get("subtitle") or testi.get("subtitle"),
                       category=cat, category_source=csrc, language=lang,
                       series=_series(title), sku=r.sku if r else None,
                       track_count=len(tracks), duration=round(total, 1),
                       has_cover=has_cover, cover_source=cover_source, color=color,
                       credits=json.dumps(credits, ensure_ascii=False),
                       has_lyrics=int(has_lyrics), sources=json.dumps(sources))
            cols = ", ".join(row)
            conn.execute(
                f"INSERT INTO albums({cols}) VALUES({', '.join('?' * len(row))}) "
                f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{k}=excluded.{k}' for k in row if k != 'id')}",
                tuple(row.values()))
            existing.discard(fid)

            search_rows = [(fid, None, "album", title)]
            if doc.get("title"):
                search_rows.append((fid, None, "album", doc["title"]))
            for role, names in credits.items():
                search_rows.append((fid, None, "credit", " ".join(names)))
            for t in tracks:
                cur = conn.execute(
                    "INSERT INTO tracks(album_id, idx, title, title_source, duration, bitrate, size, "
                    "source_kind, source_path, alt_path, is_extra, lyrics, valid) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fid, t["idx"], t["title"], t["title_source"], t["info"].get("duration") or 0,
                     t["info"].get("bitrate"), t["info"].get("size"), t["kind"], str(t["src"]),
                     str(t["alt"]) if t["alt"] else None, int(bool(t.get("extra"))),
                     t.get("lyrics"), int(bool(t["info"].get("valid")))))
                if t["title_source"] != "generic":
                    search_rows.append((fid, cur.lastrowid, "track", t["title"]))
                if t.get("lyrics"):
                    search_rows.append((fid, cur.lastrowid, "lyrics", t["lyrics"]))
            conn.executemany("INSERT INTO search(album_id, track_id, kind, text) VALUES(?,?,?,?)",
                             search_rows)
            for kind, path in sorted(a.pdfs.items()):
                conn.execute("INSERT INTO documents(album_id, kind, path, name) VALUES(?,?,?,?)",
                             (fid, kind, str(path), path.name))

        # ---- audiobooks
        n_books = _audiobooks_phase(conn, st, existing, issue)

        # ---- missing covers: manual files, reviewed candidates, catalogue, retailers
        _covers_phase(conn, st, reg, srcs, issue)
        conn.execute("UPDATE albums SET description=NULL, age=NULL, contents=NULL, product_url=NULL "
                     "WHERE kind='faba'")
        if settings.online_details:
            _details_phase(conn, st, reg, srcs, issue)
        if n_books and (settings.online_covers or settings.online_details):
            try:
                bookinfo.import_phase(conn, st, issue)
            except Exception as e:  # network problems must not break the import
                log.warning("audiobook details lookup failed: %s", e)

        # ---- same recording released with several figures (other-language editions)
        conn.execute("UPDATE albums SET duplicate_of=NULL")
        by_fp: dict[tuple, list[str]] = defaultdict(list)
        for fid, fps in album_fp.items():
            by_fp[fps].append(fid)
        for fids in by_fp.values():
            if len(fids) < 2:
                continue
            owner, *others = sorted(fids)
            for f in others:
                conn.execute("UPDATE albums SET duplicate_of=? WHERE id=?", (owner, f))
                issue(f, None, "info", "audio_duplicate",
                      f"Stesso audio dell'album {owner} (edizione per un'altra lingua/figura)")

        for gone in existing:
            conn.execute("DELETE FROM albums WHERE id=?", (gone,))
        conn.executemany("INSERT INTO issues(album_id, track_idx, level, code, message) VALUES(?,?,?,?,?)",
                         issues)
        # album status from issues
        conn.execute("UPDATE albums SET status='ok'")
        conn.execute("UPDATE albums SET status='warning' WHERE id IN "
                     "(SELECT album_id FROM issues WHERE level='warning')")
        conn.execute("UPDATE albums SET status='error' WHERE id IN "
                     "(SELECT album_id FROM issues WHERE level='error')")
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('last_import', datetime('now'))")
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('asset_dir', ?)", (str(root),))

        st.stats = {
            "albums": len(srcs), "audiobooks": n_books, "tracks_ok": n_ok, "tracks_bad": n_bad,
            "errors": sum(1 for i in issues if i[2] == "error"),
            "warnings": sum(1 for i in issues if i[2] == "warning"),
            "seconds": round(time.time() - st.started_at, 1),
        }
    # resume points refer to track ids, which are new after every import
    # (a separate transaction: user.db must not stay locked during the import)
    with db.session() as conn:
        new = {(r[1], r[2]): r[0] for r in conn.execute("SELECT id, album_id, idx FROM tracks")}
        remap = {old: new[key] for old, key in old_tracks.items() if key in new and new[key] != old}
        track_remap.clear()
        track_remap.update(remap)
        for profile, album, tid in conn.execute(
                "SELECT profile_id, album_id, track_id FROM profile_progress").fetchall():
            if tid in remap:
                conn.execute("UPDATE profile_progress SET track_id=? WHERE profile_id=? AND album_id=?",
                             (remap[tid], profile, album))
    # files of covers that no longer exist (after commit: readers saw the old catalogue until now)
    with db.session() as conn:
        for (fid,) in conn.execute("SELECT id FROM albums WHERE has_cover=0"):
            (settings.covers_dir / f"{fid}.png").unlink(missing_ok=True)
    st.phase = "done"
    st.done = st.total
    st.emit(f"Import completato: {len(srcs)} album, {n_books} audiolibri, {n_ok} tracce ok, "
            f"{n_bad} non valide in {st.stats['seconds']}s")


if __name__ == "__main__":  # python -m fava.importer
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    db.init()
    state.running = True
    run_import()
    print(json.dumps(state.stats, indent=2))
