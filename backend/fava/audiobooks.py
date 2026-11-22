"""Audiobooks: M4B / M4A / MP3 files that are not Faba figures.

Roots (scanned recursively):

* ``<asset>/audiobooks`` or ``<asset>/audiolibri``   read-only library
* ``FAVA_AUDIOBOOK_DIR``                               an existing library mounted elsewhere
* ``<data>/audiobooks/<batch>/``                       uploaded from the browser

Grouping into books:

* every ``.m4b`` file is a book, unless several files in the same folder carry the
  same album tag (a book split in parts);
* ``.mp3`` / ``.m4a`` files in a folder form one book (usually one file per chapter),
  split by album tag when the folder mixes several books.

Metadata comes from the tags (title, author, narrator, description, genre, cover),
falling back to file and folder names. Chapters are read from the QuickTime chapter
track or the Nero ``chpl`` atom (M4B) and from ID3 ``CHAP`` frames (MP3).

Audience (kids / adults) is guessed from folder names (``bambini``, ``adulti``…)
and the genre tag; it can be changed from the UI (``album_overrides``).
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import struct
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

AUDIO_EXT = {".m4b", ".m4a", ".mp3"}
COVER_NAMES = ("cover", "folder", "front", "copertina", "poster")
ROOT_DIR_NAMES = {"audiobooks", "audiolibri"}  # below the asset folder

KIDS_WORDS = ("bambin", "bimb", "ragazz", "infanzia", "kids", "kid's", "children", "child", "juvenile",
              "junior", "jeunesse", "enfant", "infantil", "niños", "ninos", "kinder")
ADULT_WORDS = ("adulti", "adult", "grandi", "erwachsen")
RE_GENERIC_CHAPTER = re.compile(r"^(chapter|capitolo|chapitre|cap[ií]tulo|kapitel|track|traccia|part[e]?)?\s*\d+$",
                                re.I)
RE_LEADING_NUM = re.compile(r"^\s*(?:\d{1,3}|cd\s*\d+)\s*[-_.)]\s*", re.I)
PROBE_VERSION = 2  # bump when probe() output changes


def roots() -> list[Path]:
    out = []
    a = settings.asset_dir
    if a.is_dir():
        out += [d for d in a.iterdir() if d.is_dir() and d.name.lower() in ROOT_DIR_NAMES]
    if settings.audiobook_dir and settings.audiobook_dir.is_dir():
        out.append(settings.audiobook_dir)
    up = upload_root()
    if up.is_dir():
        out.append(up)
    seen, uniq = set(), []
    for r in out:
        k = str(r.resolve())
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    return uniq


def upload_root() -> Path:
    return settings.data_dir / "audiobooks"


def is_audiobook_id(s: str) -> bool:
    return bool(re.fullmatch(r"ab[0-9a-f]{10}", s))


def book_id(key: str) -> str:
    """Stable id from the location below its root (moving the root keeps ids)."""
    return "ab" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]


# --------------------------------------------------------------------------- MP4 chapter track

def _boxes(f, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        size, typ = struct.unpack(">I4s", hdr)
        hlen = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            hlen = 16
        elif size == 0:
            size = end - pos
        if size < hlen:
            return
        yield typ, pos + hlen, min(pos + size, end)
        pos += size


def _child(f, start, end, typ):
    for t, s, e in _boxes(f, start, end):
        if t == typ:
            return s, e
    return None


def _path(f, start, end, *types):
    rng = (start, end)
    for t in types:
        rng = _child(f, rng[0], rng[1], t)
        if rng is None:
            return None
    return rng


def _read(f, rng) -> bytes:
    f.seek(rng[0])
    return f.read(rng[1] - rng[0])


def qt_chapters(path: Path) -> list[dict]:
    """Chapters from a QuickTime chapter track (text track referenced by ``tref/chap``)."""
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        moov = _child(f, 0, size, b"moov")
        if not moov:
            return []
        traks, chap_ids = {}, set()
        for t, s, e in _boxes(f, *moov):
            if t != b"trak":
                continue
            tkhd = _child(f, s, e, b"tkhd")
            if not tkhd:
                continue
            d = _read(f, (tkhd[0], min(tkhd[1], tkhd[0] + 32)))
            tid = struct.unpack(">I", d[12:16] if d[0] == 0 else d[20:24])[0]
            traks[tid] = (s, e)
            chap = _path(f, s, e, b"tref", b"chap")
            if chap:
                d = _read(f, chap)
                chap_ids.update(struct.unpack(f">{len(d) // 4}I", d[: len(d) // 4 * 4]))
        for cid in sorted(chap_ids):
            if cid not in traks:
                continue
            s, e = traks[cid]
            mdia = _child(f, s, e, b"mdia")
            if not mdia:
                continue
            mdhd = _child(f, *mdia, b"mdhd")
            stbl = _path(f, *mdia, b"minf", b"stbl")
            if not mdhd or not stbl:
                continue
            d = _read(f, mdhd)
            timescale = struct.unpack(">I", d[12:16] if d[0] == 0 else d[20:24])[0] or 1
            boxes = {t: (bs, be) for t, bs, be in _boxes(f, *stbl)}
            if b"stts" not in boxes or b"stsz" not in boxes or b"stsc" not in boxes:
                continue
            # sample times
            d = _read(f, boxes[b"stts"])
            n = struct.unpack(">I", d[4:8])[0]
            times, t0 = [], 0
            for i in range(n):
                cnt, delta = struct.unpack(">II", d[8 + i * 8: 16 + i * 8])
                for _ in range(cnt):
                    times.append(t0)
                    t0 += delta
            # sample sizes
            d = _read(f, boxes[b"stsz"])
            fixed, cnt = struct.unpack(">II", d[4:12])
            sizes = [fixed] * cnt if fixed else list(struct.unpack(f">{cnt}I", d[12: 12 + cnt * 4]))
            # chunk offsets
            if b"stco" in boxes:
                d = _read(f, boxes[b"stco"])
                k = struct.unpack(">I", d[4:8])[0]
                chunks = list(struct.unpack(f">{k}I", d[8: 8 + k * 4]))
            elif b"co64" in boxes:
                d = _read(f, boxes[b"co64"])
                k = struct.unpack(">I", d[4:8])[0]
                chunks = list(struct.unpack(f">{k}Q", d[8: 8 + k * 8]))
            else:
                continue
            d = _read(f, boxes[b"stsc"])
            k = struct.unpack(">I", d[4:8])[0]
            stsc = [struct.unpack(">III", d[8 + i * 12: 20 + i * 12]) for i in range(k)]
            # sample offsets
            offsets, si = [], 0
            for ci, coff in enumerate(chunks, start=1):
                spc = 0
                for first, per, _desc in stsc:
                    if first <= ci:
                        spc = per
                    else:
                        break
                o = coff
                for _ in range(spc):
                    if si >= len(sizes):
                        break
                    offsets.append(o)
                    o += sizes[si]
                    si += 1
            out = []
            for i, (off, sz) in enumerate(zip(offsets, sizes)):
                if i >= len(times) or sz < 2:
                    continue
                f.seek(off)
                raw = f.read(min(sz, 2048))
                ln = struct.unpack(">H", raw[:2])[0]
                txt = raw[2: 2 + ln]
                if txt[:2] in (b"\xfe\xff", b"\xff\xfe"):
                    title = txt.decode("utf-16", "replace")
                else:
                    title = txt.decode("utf-8", "replace")
                out.append({"start": round(times[i] / timescale, 3), "title": title.strip()})
            if out:
                return out
    return []


# --------------------------------------------------------------------------- probing

def _first(tags, *keys) -> str | None:
    for k in keys:
        v = tags.get(k) if tags is not None else None
        if v is None:
            continue
        if isinstance(v, list):
            v = v[0] if v else None
        if v is None:
            continue
        s = (bytes(v).decode("utf-8", "replace") if isinstance(v, bytes) else str(v)).strip()
        if s:
            return s
    return None


def probe(path: Path) -> dict:
    """Tags, duration, chapters (cached per file by the importer)."""
    info: dict = {"v": PROBE_VERSION, "size": path.stat().st_size, "valid": False}
    ext = path.suffix.lower()
    try:
        if ext == ".mp3":
            from mutagen.mp3 import MP3

            audio = MP3(str(path))
            tags = audio.tags or {}

            def t(*ks):
                for k in ks:
                    for key in (tags.keys() if hasattr(tags, "keys") else []):
                        if key == k or key.startswith(k + ":"):
                            s = str(tags[key]).strip()
                            if s:
                                return s
                return None
            info.update(title=t("TIT2"), album=t("TALB"), artist=t("TPE1"), album_artist=t("TPE2"),
                        narrator=t("TCOM"), genre=t("TCON"), year=t("TDRC", "TYER"),
                        description=t("COMM"), language=t("TLAN"),
                        track=_num(t("TRCK")), disc=_num(t("TPOS")),
                        has_cover=any(k.startswith("APIC") for k in tags.keys()) if tags else False)
            chapters = []
            for k in (tags.keys() if tags else []):
                if k.startswith("CHAP"):
                    fr = tags[k]
                    title = None
                    sub = getattr(fr, "sub_frames", None)
                    if sub is not None and "TIT2" in sub:
                        title = str(sub["TIT2"]).strip()
                    chapters.append({"start": round(fr.start_time / 1000, 3), "title": title or ""})
            info["chapters"] = sorted(chapters, key=lambda c: c["start"])
        else:
            from mutagen.mp4 import MP4

            audio = MP4(str(path))
            tags = audio.tags or {}
            trkn, disk = tags.get("trkn"), tags.get("disk")
            info.update(title=_first(tags, "\xa9nam"), album=_first(tags, "\xa9alb"),
                        artist=_first(tags, "\xa9ART"), album_artist=_first(tags, "aART"),
                        narrator=_first(tags, "\xa9nrt", "----:com.apple.iTunes:NARRATOR",
                                        "----:com.apple.iTunes:narrator", "\xa9wrt"),
                        genre=_first(tags, "\xa9gen"), year=_first(tags, "\xa9day"),
                        description=_first(tags, "ldes", "desc", "\xa9cmt"),
                        language=_first(tags, "----:com.apple.iTunes:LANGUAGE", "----:com.apple.iTunes:language"),
                        track=trkn[0][0] if trkn else None, disc=disk[0][0] if disk else None,
                        has_cover=bool(tags.get("covr")))
            chapters = []
            try:
                chapters = qt_chapters(path)
            except Exception as e:  # malformed file: fall back to the Nero atom
                log.debug("qt chapters %s: %s", path, e)
            if not chapters and getattr(audio, "chapters", None):
                chapters = [{"start": round(c.start, 3), "title": (c.title or "").strip()} for c in audio.chapters]
            info["chapters"] = chapters
        info["duration"] = round(float(audio.info.length or 0), 2)
        info["bitrate"] = int(getattr(audio.info, "bitrate", 0) or 0)
        info["valid"] = info["duration"] > 0
        # drop chapters past the end and a lone chapter covering the whole file
        ch = [c for c in info.get("chapters", []) if c["start"] < info["duration"] - 0.5]
        if len(ch) == 1 and ch[0]["start"] < 1:
            ch = []
        info["chapters"] = ch
    except Exception as e:
        info["error"] = str(e)
    return info


def _num(s: str | None) -> int | None:
    if not s:
        return None
    m = re.match(r"\s*(\d+)", s)
    return int(m.group(1)) if m else None


def embedded_cover(path: Path) -> bytes | None:
    try:
        if path.suffix.lower() == ".mp3":
            from mutagen.id3 import ID3

            tags = ID3(str(path))
            pics = tags.getall("APIC")
            front = [p for p in pics if p.type == 3] or pics
            return front[0].data if front else None
        from mutagen.mp4 import MP4

        covr = (MP4(str(path)).tags or {}).get("covr")
        return bytes(covr[0]) if covr else None
    except Exception:
        return None


def folder_cover(folder: Path) -> Path | None:
    try:
        files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    except OSError:
        return None
    for name in COVER_NAMES:
        for f in files:
            if f.stem.lower() == name:
                return f
    return files[0] if len(files) == 1 else None


def to_png(data: bytes) -> bytes | None:
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None
    img.thumbnail((720, 720))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------------- scanning

@dataclass
class Book:
    id: str
    root: Path
    folder: Path
    key: str
    files: list[Path] = field(default_factory=list)


def _natural(s: str):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", s)]


def scan(probe_cached) -> list[Book]:
    """Group audio files into books. ``probe_cached(path)`` returns probe() output."""
    books: dict[str, Book] = {}
    for root in roots():
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            folder = Path(dirpath)
            audio = sorted((folder / f for f in filenames
                            if Path(f).suffix.lower() in AUDIO_EXT and not f.startswith(".")),
                           key=lambda p: _natural(p.name))
            if not audio:
                continue
            rel = folder.relative_to(root).as_posix()
            groups: dict[str, list[Path]] = defaultdict(list)
            m4b = [p for p in audio if p.suffix.lower() == ".m4b"]
            other = [p for p in audio if p.suffix.lower() != ".m4b"]
            # m4b: one book per file, or per album tag when several files share it
            by_album: dict[str, list[Path]] = defaultdict(list)
            for p in m4b:
                alb = (probe_cached(p).get("album") or "").strip().lower()
                by_album[alb].append(p)
            for alb, files in by_album.items():
                if alb and len(files) > 1:
                    groups[f"{rel}#album:{alb}"] += files
                else:
                    for p in files:
                        groups[f"{rel}/{p.name}"].append(p)
            # mp3 / m4a: one book per folder (split when album tags differ)
            if other:
                albums = {(probe_cached(p).get("album") or "").strip().lower() for p in other}
                albums.discard("")
                if len(albums) > 1:
                    for p in other:
                        alb = (probe_cached(p).get("album") or "").strip().lower()
                        groups[f"{rel}#album:{alb}" if alb else f"{rel}/{p.name}"].append(p)
                else:
                    groups[f"{rel}#folder"] += other
            for key, files in groups.items():
                bid = book_id(key)
                if bid in books:  # same relative path in two roots: keep the first
                    continue
                books[bid] = Book(bid, root, folder, key, files)
    return list(books.values())


def detect_audience(book: Book, genre: str | None) -> str | None:
    parts = [p.lower() for p in book.folder.relative_to(book.root).parts]
    for part in parts:
        if any(w in part for w in KIDS_WORDS):
            return "kids"
        if any(w in part for w in ADULT_WORDS):
            return "adults"
    g = (genre or "").lower()
    if any(w in g for w in KIDS_WORDS):
        return "kids"
    return None


def clean_name(s: str) -> str:
    s = RE_LEADING_NUM.sub("", s)
    s = re.sub(r"[_]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_names(s: str | None) -> list[str]:
    if not s:
        return []
    parts = re.split(r"\s*(?:;|,|&|/|\be\b|\band\b)\s*", s)
    return [p for p in (x.strip() for x in parts) if p]


def is_generic(title: str | None) -> bool:
    return not title or bool(RE_GENERIC_CHAPTER.match(title.strip()))


def describe(book: Book, infos: list[dict]) -> dict:
    """Book-level metadata from the per-file probes."""
    first = infos[0] if infos else {}
    single = len(book.files) == 1

    def common(k):
        vals = [i.get(k) for i in infos if i.get(k)]
        return max(set(vals), key=vals.count) if vals else None

    album = common("album")
    if single:
        title, tsrc = (first.get("album") or first.get("title")), "tag"
    else:
        title, tsrc = album, "tag"
    if not title:
        name = book.files[0].stem if single else book.folder.name
        title, tsrc = clean_name(name) or name, "file" if single else "folder"
    author = common("album_artist") or common("artist")
    narrator = common("narrator")
    if narrator and author and narrator.lower() == author.lower():
        narrator = None
    # "Author - Title" file / folder names
    if not author:
        name = clean_name(book.files[0].stem if single else book.folder.name)
        m = re.match(r"^(.+?)\s+-\s+(.+)$", name)
        if m and tsrc != "tag":
            author, title = m.group(1).strip(), m.group(2).strip()
        elif m and _norm(m.group(2)) and (_norm(m.group(2)) in _norm(title) or _norm(title) in _norm(m.group(2))):
            author = m.group(1).strip()
    desc = common("description")
    return {"title": title, "title_source": tsrc, "author": author, "narrator": narrator,
            "description": desc, "genre": common("genre"), "year": (common("year") or "")[:4] or None,
            "language": (common("language") or "")[:2].lower() or None}


def _norm(s: str) -> str:
    return re.sub(r"[^\w]+", " ", s.lower()).strip()


def track_title(path: Path, info: dict, book_title: str, single: bool) -> tuple[str, str]:
    if single:
        return book_title, "book"
    t = info.get("title")
    if t and t.strip().lower() != book_title.strip().lower():
        return t, "tag"
    return clean_name(path.stem) or path.stem, "file"


def credits(meta: dict) -> str:
    c = {}
    if meta.get("author"):
        c["author"] = split_names(meta["author"])
    if meta.get("narrator"):
        c["narrator"] = split_names(meta["narrator"])
    return json.dumps(c, ensure_ascii=False)
