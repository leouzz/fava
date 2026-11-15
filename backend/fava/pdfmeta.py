"""Best-effort metadata extraction from the official Faba PDF booklets.

Booklets come in three flavours (suffix of the file name):

* ``Documento`` – one page: category subtitle, title, credits, figure picture.
* ``Testi``     – tracklist on page 1 followed by lyrics, one song per page.
* ``Attivita``  – activity sheets (only linked, not parsed).

Text in these PDFs uses custom ligature glyphs and shifted glyphs, so
everything here is heuristic and must never make an import fail.
"""

from __future__ import annotations

import io
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# Glyphs mapped into the Private Use Area by the booklet fonts.
_GLYPHS = {"": "tt", "": "tt", "": "ti", "": "ff"}

CATEGORY_KEYWORDS = {
    "rhymes": ("filastrocche", "comptines", "rimas", "nurseryrhymes"),
    "stories": ("storie", "fiabe", "cuentos", "historias", "contes", "histoires", "stories"),
    "music": ("musiche", "canzoni", "musiques", "chansons", "canciones", "musica", "música",
              "music", "songs", "cançons"),
}
SUBTITLE_LANG = {
    "storieefiabesonore": "it", "musiche,canzoniesuoni": "it", "filastrocche": "it",
    "cuentosehistoriassonoras": "es", "músicas,cancionesysonidos": "es",
    "música,cancionesysonidos": "es",
    "contesdeféesethistoiressonores": "fr", "musiques,chansonsetsons": "fr",
}

CREDIT_HEADINGS = {
    # squashed heading -> canonical role
    "testo": "text", "testi": "text", "texte": "text", "texto": "text", "text": "text",
    "testoeregia": "text", "adattamento": "text", "adaptation": "text", "adaptación": "text",
    "traduzione": "translation", "traduction": "translation", "traducción": "translation",
    "voci": "voices", "voce": "voices", "voix": "voices", "voces": "voices", "voices": "voices",
    "narratore": "voices", "narrazione": "voices", "interpretazione": "voices",
    "musiche": "music", "musica": "music", "música": "music", "musiques": "music", "music": "music",
    "musicheesounddesign": "music", "musiquesetdesignsonore": "music",
    "músicaydiseñodesonido": "music", "musicheetesti": "music", "musiquesetparoles": "music",
    "arrangiamenti": "music", "canzoni": "music", "musicaedesignsonoro": "music",
    "sounddesign": "sound", "designsonore": "sound", "diseñodesonido": "sound",
    "editingaudio": "sound",
    "consulenza": "advisor", "conseilscientifique": "advisor", "asesoramiento": "advisor",
    "consulenzascientifica": "advisor",
    "illustrazioni": "illustrations", "illustrations": "illustrations",
}


def clean(text: str) -> str:
    for k, v in _GLYPHS.items():
        text = text.replace(k, v)
    # "I\x00" is a broken "Il" ligature; elsewhere \x00 stands for ":".
    text = re.sub(r"\bI\x00(?=\s)", "Il", text)
    text = text.replace("\x00", ":")
    text = "".join(ch for ch in text if not (0xE000 <= ord(ch) <= 0xF8FF))
    return unicodedata.normalize("NFC", text)


def squash(text: str) -> str:
    """Lower-case, no spaces/colons – compares headings with broken kerning."""
    return re.sub(r"[\s:]+", "", text).lower()


def norm_title(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s)


def classify_subtitle(sub: str) -> tuple[str | None, str | None]:
    s = squash(sub)
    lang = SUBTITLE_LANG.get(s)
    for cat, keys in CATEGORY_KEYWORDS.items():
        if any(k in s for k in keys):
            return cat, lang
    return None, lang


@dataclass
class Booklet:
    subtitle: str | None = None
    category: str | None = None
    language: str | None = None
    title: str | None = None
    credits: dict[str, list[str]] = field(default_factory=dict)
    tracklist: dict[int, str] = field(default_factory=dict)
    lyrics: list[tuple[str, str]] = field(default_factory=list)  # (heading, text)
    cover_png: bytes | None = None


@dataclass
class Seg:
    text: str
    x0: float
    top: float
    size: float


def _char_h(c: dict) -> float:
    return max(c["bottom"] - c["top"], c.get("size", 0) or 0)


def _segments(page, gap: float = 22.0) -> list[Seg]:
    """Group characters into visual line segments.

    Booklet fonts shift glyphs vertically, so lines are clustered with a
    tolerance and characters re-sorted by x. A line is split into separate
    segments where there is a large horizontal gap (multi-column layouts).
    """
    chars = sorted((c for c in page.chars if c.get("upright", True)), key=lambda c: c["top"])
    rows: list[list[dict]] = []
    for c in chars:
        tol = max(5.0, 0.3 * _char_h(c))
        for r in reversed(rows[-3:]):
            if abs(r[0]["top"] - c["top"]) <= tol:
                r.append(c)
                break
        else:
            rows.append([c])

    segs: list[Seg] = []

    def flush(cur: list[dict]) -> None:
        if not cur:
            return
        txt, prev = "", None
        for ch in cur:
            if (prev is not None and ch["text"] != " " and not txt.endswith(" ")
                    and ch["x0"] - prev["x1"] > 0.35 * max(prev["x1"] - prev["x0"], 3)):
                txt += " "
            txt += ch["text"]
            prev = ch
        txt = re.sub(r"\s+", " ", clean(txt)).strip()
        if txt:
            segs.append(Seg(txt, cur[0]["x0"], min(c["top"] for c in cur),
                            max(_char_h(c) for c in cur)))

    for r in rows:
        r.sort(key=lambda c: c["x0"])
        cur: list[dict] = []
        for ch in r:
            if cur and ch["x0"] - cur[-1]["x1"] > gap:
                flush(cur)
                cur = []
            cur.append(ch)
        flush(cur)
    segs.sort(key=lambda s: (round(s.top / 4), s.x0))
    return segs


def _parse_front(segs: list[Seg], b: Booklet, with_credits: bool) -> None:
    segs = [s for s in segs if s.text.upper() != "FABA"]
    if not segs:
        return
    big = max(s.size for s in segs)
    is_big = lambda s: s.size >= max(20.0, big * 0.7)  # noqa: E731
    title_segs = [s for s in segs if is_big(s)]
    title_top = title_segs[0].top if title_segs else 1e9
    subs = [s for s in segs if s.top < title_top and not is_big(s)]
    if subs:
        b.subtitle = " ".join(s.text for s in subs[:3])
        b.category, b.language = classify_subtitle(b.subtitle)
    if title_segs:
        parts = [title_segs[0]]
        for s in title_segs[1:]:
            if s.top - parts[-1].top < big * 1.8:
                parts.append(s)
        b.title = " ".join(p.text for p in parts).strip(" :")
    if not with_credits:
        return
    role = None
    for s in segs:
        if s.top <= title_top or is_big(s):
            continue
        key = squash(s.text)
        if key in CREDIT_HEADINGS:
            role = CREDIT_HEADINGS[key]
            continue
        if role and len(s.text) > 2:
            for n in re.split(r",|;| e (?=[A-Z])| et (?=[A-Z])| y (?=[A-Z])", s.text):
                n = n.strip(" ,.:")
                if n and n not in b.credits.get(role, []):
                    b.credits.setdefault(role, []).append(n)


def _parse_tracklist(segs: list[Seg], b: Booklet) -> None:
    nums = [s for s in segs if re.fullmatch(r"\d{1,2}", s.text)]
    if len(nums) < 2:
        return
    col = lambda s: round(s.x0 / 20)  # noqa: E731
    cols = sorted({col(n) for n in nums})
    for n in nums:
        c = col(n)
        right = min([k * 20 for k in cols if k > c + 1], default=10_000) - 5
        below = sorted(m.top for m in nums if col(m) == c and m.top > n.top + 2)
        bottom = below[0] - 1 if below else n.top + 60
        parts = [s for s in segs if s is not n and n.x0 + 4 <= s.x0 < right
                 and n.top - 3 <= s.top < bottom and not re.fullmatch(r"\d{1,2}", s.text)]
        title = " ".join(p.text for p in sorted(parts, key=lambda s: s.top)).strip()
        if title:
            b.tracklist[int(n.text)] = title


def _extract_cover(pdf_path: Path) -> bytes | None:
    """Render the figure picture (largest non full-page image) to PNG."""
    try:
        import pypdfium2 as pdfium
        import pypdfium2.raw as raw

        doc = pdfium.PdfDocument(str(pdf_path))
        try:
            page = doc[0]
            pw, ph = page.get_size()
            best, best_area = None, 0.0
            for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=3):
                left, bottom, right, top = (getattr(obj, "get_bounds", None) or obj.get_pos)()
                w, h = right - left, top - bottom
                if w > pw * 0.9 and h > ph * 0.9:  # page background
                    continue
                if w * h > best_area:
                    best, best_area = obj, w * h
            if best is None or best_area < 2000:
                return None
            # Rendering applies the alpha mask but happens at page scale (~72 dpi):
            # temporarily enlarge the object's matrix to get the native resolution.
            img = best.get_bitmap(render=True).to_pil()
            try:
                native_w = (best.get_size() if hasattr(best, "get_size") else best.get_px_size())[0]
                k = min(native_w / max(img.width, 1), 8.0)
                if k > 1.2:
                    m = best.get_matrix()
                    best.set_matrix(m.scale(k, k))
                    try:
                        img = best.get_bitmap(render=True).to_pil()
                    finally:
                        best.set_matrix(m)
            except Exception as e:  # keep the low-res render
                log.debug("hi-res render failed for %s: %s", pdf_path, e)
            if img.mode in ("RGBA", "LA"):
                bbox = img.getchannel("A").point(lambda v: 255 if v > 16 else 0).getbbox()
                if bbox:
                    img = img.crop(bbox)
            img.thumbnail((720, 720))
            out = io.BytesIO()
            img.save(out, "PNG", optimize=True)
            return out.getvalue()
        finally:
            doc.close()
    except Exception as e:  # pragma: no cover - best effort
        log.debug("cover extraction failed for %s: %s", pdf_path, e)
        return None


def parse_booklet(path: Path, kind: str, want_cover: bool = True) -> Booklet:
    import pdfplumber

    b = Booklet()
    try:
        with pdfplumber.open(str(path)) as pdf:
            first = _segments(pdf.pages[0])
            if kind in ("Documento", "Testi"):
                _parse_front(first, b, with_credits=(kind == "Documento"))
            if kind == "Testi":
                _parse_tracklist(first, b)
                for p in pdf.pages[1:]:
                    segs = _segments(p, gap=40)
                    if not segs:
                        continue
                    big = max(s.size for s in segs)
                    is_head = lambda s: big > 14 and s.size >= big * 0.8  # noqa: E731
                    mid = p.width * 0.45
                    two_cols = any(is_head(s) and s.x0 > mid for s in segs)
                    columns = ([[s for s in segs if s.x0 <= mid], [s for s in segs if s.x0 > mid]]
                               if two_cols else [segs])
                    for colsegs in columns:
                        colsegs.sort(key=lambda s: (s.top, s.x0))
                        for s in colsegs:
                            if is_head(s):
                                # multi-line headings: merge with a heading right above
                                if (b.lyrics and not b.lyrics[-1][1]
                                        and b.lyrics[-1][0]):
                                    b.lyrics[-1] = (b.lyrics[-1][0] + " " + s.text, "")
                                else:
                                    b.lyrics.append((s.text, ""))
                            elif b.lyrics:
                                h, t = b.lyrics[-1]
                                b.lyrics[-1] = (h, (t + "\n" + s.text) if t else s.text)
                            else:
                                b.lyrics.append(("", s.text))
    except Exception as e:
        log.warning("cannot parse %s: %s", path.name, e)
    if want_cover and kind == "Documento":
        b.cover_png = _extract_cover(path)
    return b
