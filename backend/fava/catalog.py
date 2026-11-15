"""Optional cover lookup in the official online catalogue (myfaba stores).

Only used for albums whose booklet did not provide a figure picture. Matching:

1. candidate products are picked by comparing the album title / registry name
   with the product URL slugs listed in each store's XML sitemap;
2. the candidate's product page (lightweight "quick view") is fetched and
   accepted if its SKU equals the registry SKU, or – when no SKU is known –
   if its name is a near-exact match.

Everything is cached under ``<data>/catalog`` so each page and image is
downloaded once. Images are only stored locally, never redistributed.
"""

from __future__ import annotations

import hashlib
import html
import io
import json
import logging
import re
import time
import unicodedata
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

UA = "Mozilla/5.0 (compatible; FAVA self-hosted player)"
INDEX_TTL = 7 * 86400
REQUEST_GAP = 0.6  # seconds between requests: be gentle with the shop
STORE_LANG = {"myfaba.it": "it", "myfaba.es": "es", "myfaba.fr": "fr"}
_STOP = {"il", "lo", "la", "le", "i", "gli", "di", "del", "della", "e", "a", "the", "of", "and", "el",
         "los", "las", "y", "de", "les", "des", "et", "du", "un", "una", "une", "con", "avec",
         "altre", "altra", "storie", "storia", "otro", "cuento", "autre", "histoire", "disney", "faba"}

_last_request = 0.0


def _dir() -> Path:
    d = settings.data_dir / "catalog"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get(url: str, headers: dict | None = None, timeout: int = 20) -> bytes:
    global _last_request
    wait = REQUEST_GAP - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    finally:
        _last_request = time.time()


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(re.findall(r"[a-z0-9]+", s))


def _words(s: str) -> set[str]:
    return {w for w in _norm(s).split() if w not in _STOP}


def similarity(a: str, b: str) -> float:
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    chars = SequenceMatcher(None, na, nb).ratio()
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return chars
    jacc = len(wa & wb) / len(wa | wb)
    contain = len(wa & wb) / min(len(wa), len(wb))  # "Il gatto con gli stivali" ⊂ "… e altre storie"
    return max((chars + jacc) / 2, 0.9 * contain if min(len(wa), len(wb)) >= 2 else 0)


# --------------------------------------------------------------------------- index

def load_index() -> list[dict]:
    """Product URLs from every configured store (cached for a week)."""
    path = _dir() / "index.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - data.get("ts", 0) < INDEX_TTL and data.get("stores") == settings.catalog_stores:
            return data["products"]
    products: list[dict] = []
    for store in settings.catalog_stores:
        page = 1
        while page < 20:
            try:
                xml = _get(f"{store}/xmlsitemap.php?type=products&page={page}").decode("utf-8", "replace")
            except Exception as e:
                log.info("catalog sitemap %s failed: %s", store, e)
                break
            urls = re.findall(r"<loc>([^<]+)</loc>", xml)
            if not urls:
                break
            host = re.sub(r"^https?://(www\.)?", "", store).split("/")[0]
            for u in urls:
                slug = u.rstrip("/").rsplit("/", 1)[-1]
                products.append({"url": html.unescape(u), "slug": slug.replace("-", " "),
                                 "lang": STORE_LANG.get(host)})
            if len(urls) < 500:
                break
            page += 1
    if products:
        path.write_text(json.dumps({"ts": time.time(), "stores": settings.catalog_stores,
                                    "products": products}, ensure_ascii=False), encoding="utf-8")
    elif path.exists():  # offline: keep using the stale index
        return json.loads(path.read_text(encoding="utf-8"))["products"]
    return products


# --------------------------------------------------------------------------- product pages

class _ProductCache:
    def __init__(self) -> None:
        self.path = _dir() / "products.json"
        self.data: dict[str, dict] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=0), encoding="utf-8")


def _parse_product(page: str) -> dict:
    name = re.search(r'class="productView-title"[^>]*>\s*([^<]+?)\s*<', page)
    sku = re.search(r"data-product-sku[^>]*>\s*([^<\s]+)\s*<", page) or \
        re.search(r'"sku"\s*:\s*"([^"]+)"', page)
    imgs = re.findall(r"https://cdn\d+\.bigcommerce\.com/[^\"' ]*?/products/\d+/(?:images/)?\d+/[^\"' ?]+\.(?:jpe?g|png|webp)",
                      page)
    seen, ordered = set(), []
    for u in imgs:
        key = u.rsplit("/", 1)[-1]
        if key not in seen:
            seen.add(key)
            ordered.append(u)
    # the figure photo is the "raccontastorie-…" one; else the first image
    main = next((u for u in ordered if "raccontastorie" in u.rsplit("/", 1)[-1]), ordered[0] if ordered else None)
    if main in ordered:  # main first, then the others in page order
        ordered.remove(main)
        ordered.insert(0, main)
    return {"name": html.unescape(name.group(1)) if name else None,
            "sku": sku.group(1).strip() if sku else None, "image": main,
            "images": ordered[:5], "ts": time.time()}


def product(cache: _ProductCache, url: str) -> dict | None:
    hit = cache.data.get(url)
    if hit and "images" in hit and (hit.get("name") or time.time() - hit.get("ts", 0) < INDEX_TTL):
        return hit
    try:
        page = _get(url, headers={"stencil-config": "{}",
                                  "stencil-options": '{"render_with":"products/quick-view"}',
                                  "x-requested-with": "stencil-utils"}).decode("utf-8", "replace")
        info = _parse_product(page)
    except Exception as e:
        log.info("catalog page %s failed: %s", url, e)
        info = {"name": None, "sku": None, "image": None, "ts": time.time(), "error": str(e)}
    cache.data[url] = info
    return info


# --------------------------------------------------------------------------- images

def cut_out(jpeg: bytes) -> bytes:
    """Make the white studio background transparent and crop to the figure."""
    from PIL import Image, ImageChops, ImageDraw, ImageFilter

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    img.thumbnail((640, 640))
    w, h = img.size
    marker = (255, 0, 255)
    work = img.copy()
    px = work.load()
    seeds = [(x, y) for x in range(0, w, 8) for y in (0, h - 1)] + \
            [(x, y) for y in range(0, h, 8) for x in (0, w - 1)]
    for x, y in seeds:
        r, g, b = px[x, y]
        if min(r, g, b) >= 232 and (r, g, b) != marker:
            ImageDraw.floodfill(work, (x, y), marker, thresh=24)
    bg = ImageChops.difference(work, Image.new("RGB", work.size, marker)).convert("L")
    alpha = bg.point(lambda v: 0 if v < 8 else 255)
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out = img.convert("RGBA")
    out.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
    if bbox:
        out = out.crop(bbox)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def image_file(cache: _ProductCache, url: str) -> Path | None:
    """Download (once) and cut out a product image; returns the cached PNG."""
    name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".png"
    path = _dir() / "img" / name
    if path.exists():
        return path
    path.parent.mkdir(exist_ok=True)
    src = re.sub(r"/stencil/\d+w/", "/stencil/640w/", url)
    try:
        path.write_bytes(cut_out(_get(src)))
        return path
    except Exception as e:
        log.info("catalog image %s failed: %s", url, e)
        return None


def pick_image(urls: list[str]) -> tuple[Path | None, bool]:
    """Best photo among ``urls``: a white-background studio shot (cut out) that is
    not landscape (a figure or a book cover, not an open book spread); otherwise
    the first white shot; otherwise the first image as is."""
    from PIL import Image

    whites: list[Path] = []
    first: Path | None = None
    for u in urls[:4]:
        name = hashlib.sha1(u.encode()).hexdigest()[:16] + ".png"
        path = _dir() / "img" / name
        meta = _dir() / "img" / (name + ".white")
        if not path.exists():
            path.parent.mkdir(exist_ok=True)
            try:
                data = _get(re.sub(r"/stencil/\d+w/", "/stencil/640w/", u))
                if _is_white_studio(data):
                    path.write_bytes(cut_out(data))
                    meta.write_text("1")
                else:
                    img = Image.open(io.BytesIO(data)).convert("RGB")
                    img.thumbnail((640, 640))
                    buf = io.BytesIO()
                    img.save(buf, "PNG", optimize=True)
                    path.write_bytes(buf.getvalue())
            except Exception as e:
                log.info("image %s unusable: %s", u, e)
                continue
        if meta.exists():
            with Image.open(path) as im:
                if im.height >= 0.8 * im.width:
                    return path, True
            whites.append(path)
        first = first or path
    if whites:
        return whites[0], True
    return first, False


# --------------------------------------------------------------------------- matching

@dataclass
class Match:
    image: Path | None
    product_url: str
    product_name: str
    method: str  # sku | title


class Finder:
    def __init__(self) -> None:
        self.index = load_index()
        self.cache = _ProductCache()
        self.claimed: dict[str, set] = {}  # product url -> languages of albums using it

    def close(self) -> None:
        self.cache.save()

    def find(self, titles: list[str], sku: str | None, lang: str | None,
             exclude: set[str] | frozenset = frozenset(), with_image: bool = True) -> Match | None:
        titles = [t for t in titles if t]
        if not titles or not self.index:
            return None
        scored = []
        for p in self.index:
            s = max(similarity(t, p["slug"]) for t in titles)
            if lang and p.get("lang") == lang:
                s += 0.03
            scored.append((s, p))
        scored.sort(key=lambda x: -x[0])
        for s, p in scored[:4]:
            if s < 0.55:
                break
            if p["url"] in exclude:
                continue
            info = product(self.cache, p["url"])
            if not info or not info.get("image") or not info.get("name"):
                continue
            psku = (info.get("sku") or "").upper()
            if sku and psku:
                if psku == sku.upper():
                    method = "sku"
                else:
                    continue  # a different figure, however similar the title
            else:
                if max(similarity(t, info["name"]) for t in titles) < 0.85:
                    continue
                # Titles alone are ambiguous ("Disney - Peter Pan" vs "Peter Pan e
                # un'altra storia" are different figures), so be strict:
                used = self.claimed.get(p["url"], set()) | self.claimed.get("name:" + _norm(info["name"]), set())
                exact = max(SequenceMatcher(None, _norm(t), _norm(info["name"])).ratio()
                            for t in titles) >= 0.95
                if used:
                    # same product already shown by another album: only accept an
                    # identical title (re-release) or a translation of the same figure
                    if not exact and (lang is None or lang in used or None in used):
                        continue
                elif not (exact or (lang is not None and p.get("lang") == lang)):
                    continue
                method = "title"
            img = None
            if with_image:
                img, _white = pick_image(info.get("images") or [info["image"]])
                if not img:
                    continue
            for key in (p["url"], "name:" + _norm(info["name"])):
                self.claimed.setdefault(key, set()).add(lang)
            return Match(img, p["url"], info["name"], method)
        return None


# --------------------------------------------------------------------------- retailers
#
# Third-party shops that still list retired figures. Matching uses only their
# WordPress/Yoast product sitemaps (product URLs *and* image URLs); search
# endpoints are never used. The page of a matched product is read once for its
# description (see "product details" below).

@dataclass
class Candidate:
    image: Path
    product_url: str
    product_name: str
    score: float
    certain: bool
    source: str


def _is_white_studio(jpeg: bytes) -> bool:
    from PIL import Image

    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    img.thumbnail((200, 200))
    w, h = img.size
    px = img.load()
    border = [px[x, y] for x in range(w) for y in (0, 1, h - 2, h - 1)] + \
             [px[x, y] for y in range(h) for x in (0, 1, w - 2, w - 1)]
    white = sum(1 for p in border if min(p) >= 225)
    return white / len(border) >= 0.85


def load_retailers() -> list[dict]:
    path = _dir() / "retailers.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - data.get("ts", 0) < INDEX_TTL and data.get("src") == settings.retailer_sitemaps:
            return data["products"]
    products: list[dict] = []
    for index_url in settings.retailer_sitemaps:
        host = re.sub(r"^https?://(www\.)?", "", index_url).split("/")[0]
        try:
            idx = _get(index_url).decode("utf-8", "replace")
        except Exception as e:
            log.info("retailer sitemap %s failed: %s", index_url, e)
            continue
        maps = [u for u in re.findall(r"<loc>([^<]+)</loc>", idx) if "product" in u] or [index_url]
        for m in maps:
            try:
                xml = _get(m).decode("utf-8", "replace") if m != index_url else idx
            except Exception:
                continue
            for block in re.findall(r"<url>(.*?)</url>", xml, re.S):
                loc = re.search(r"<loc>([^<]+)</loc>", block)
                if not loc:
                    continue
                url = html.unescape(loc.group(1).strip())
                slug = url.rstrip("/").rsplit("/", 1)[-1].lower()
                words = slug.split("-")
                if "faba" not in words:  # skip fabame, accessories, other brands
                    continue
                imgs = [html.unescape(i) for i in re.findall(r"<image:loc>([^<]+)</image:loc>", block)]
                name = " ".join(w for w in words if w != "faba")
                if imgs:
                    products.append({"url": url, "name": name, "images": imgs[:3], "source": host})
    if products:
        path.write_text(json.dumps({"ts": time.time(), "src": settings.retailer_sitemaps,
                                    "products": products}, ensure_ascii=False), encoding="utf-8")
    elif path.exists():
        return json.loads(path.read_text(encoding="utf-8"))["products"]
    return products


def _variants(titles: list[str]) -> list[str]:
    out = []
    for t in titles:
        if not t:
            continue
        out.append(t)
        out.append(re.sub(r"['’]", "", t))                      # slugs drop apostrophes
        out.append(re.sub(r"^(disney|faba)\s*[-–:]\s*", "", t, flags=re.I))
    return list(dict.fromkeys(out))


class RetailerFinder:
    def __init__(self, library_titles: dict[str, str]) -> None:
        self.products = load_retailers()
        self.library = library_titles  # album id -> title (whole library)
        self.cache = _ProductCache()

    def _image(self, urls: list[str]) -> tuple[Path | None, bool]:
        return pick_image(urls)

    def find(self, album_id: str, titles: list[str], exclude: set[str]) -> Candidate | None:
        variants = _variants(titles)
        if not variants or not self.products:
            return None
        scored = sorted(((max(similarity(v, p["name"]) for v in variants), p) for p in self.products),
                        key=lambda x: -x[0])
        own = _norm(titles[0])
        for score, p in scored[:3]:
            if score < 0.6:
                break
            if p["url"] in exclude:
                continue
            exact = max(SequenceMatcher(None, _norm(v), _norm(p["name"])).ratio() for v in variants) >= 0.9
            # does this product clearly belong to another album of the library?
            other = max(((SequenceMatcher(None, _norm(t), _norm(p["name"])).ratio(), aid)
                         for aid, t in self.library.items() if aid != album_id and _norm(t) != own),
                        default=(0, None))
            if other[0] >= 0.9 and not exact:
                continue
            img, white = self._image(p["images"])
            if not img:
                continue
            return Candidate(img, p["url"], p["name"].capitalize(), round(score, 2),
                             certain=exact and white, source=p["source"])
        return None


# --------------------------------------------------------------------------- product details
#
# Description, age range and "contents" (story / song titles) of a matched
# product. Full product pages are needed here, so they are fetched once per
# product and only the parsed result is cached.

SECTION_NAMES = {
    "storie": "stories", "fiabe": "stories", "cuentos": "stories", "historias": "stories",
    "histoires": "stories", "contes": "stories", "stories": "stories",
    "canzoni": "songs", "canciones": "songs", "chansons": "songs", "songs": "songs", "cançons": "songs",
    "musiche": "music", "musica": "music", "música": "music", "musiques": "music", "musique": "music",
    "filastrocche": "rhymes", "comptines": "rhymes", "rimas": "rhymes",
    "giochi": "games", "juegos": "games", "jeux": "games", "attività": "games",
}


def _text_blocks(fragment: str) -> list[str]:
    """HTML fragment -> text lines, keeping inline formatting on one line."""
    fragment = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", fragment)
    fragment = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|ul|ol|tr)>", "\n", fragment)
    text = html.unescape(re.sub(r"<[^>]+>", "", fragment))
    return [re.sub(r"\s+", " ", ln).strip() for ln in text.split("\n") if ln.strip()]


def _parse_myfaba(page: str) -> dict:
    out: dict = {"sections": []}
    m = re.search(r'class="tracce_container"(.*?)</div>\s*</div>\s*</div>', page, re.S)
    if m:
        for col in re.findall(r'class="trace_column[^"]*"(.*?)</ul>', m.group(1), re.S):
            head = re.search(r"<h3[^>]*>(.*?)</h3>", col, re.S)
            items = [html.unescape(re.sub(r"<[^>]+>", "", li)).strip()
                     for li in re.findall(r"<li[^>]*>(.*?)</li>", col, re.S)]
            items = [i for i in items if i]
            if items:
                out["sections"].append({"name": html.unescape(head.group(1)).strip() if head else "",
                                        "items": items})
    m = re.search(r'productView-description"?[^>]*>(.*?)(?:Leggi di più|Leer más|Lire la suite|<style)',
                  page, re.S)
    if m:
        lines = [ln for ln in _text_blocks(m.group(1))
                 if ln.lower() not in ("descrizione", "descripción", "description")]
        if lines and len(lines[0]) < 90 and not lines[0].endswith("."):
            lines = lines[1:]  # "Esplora e immagina con …" heading
        out["description"] = " ".join(lines[:8])[:1200] or None
    m = re.search(r"(?:fascia d.età|edad de|tranche d.âge|âge de)\s*(?:de\s*)?(\d+)\s*[-–]\s*(\d+)",
                  html.unescape(page), re.I)
    if m:
        out["age"] = f"{m.group(1)}-{m.group(2)}"
    return out


def _parse_retailer(page: str) -> dict:
    out: dict = {"sections": []}
    m = re.search(r'id="tab-description"[^>]*>(.*?)(?:id="tab-|</section>)', page, re.S)
    if not m:
        return out
    lines = _text_blocks(m.group(1))
    desc = []
    stop = re.compile(r"^(contenuto adatto a|tipo di contenuto|durata|editore|_{3,}|ascolta l)", re.I)
    for i, ln in enumerate(lines):
        if stop.match(ln):
            break
        if i == 0 and ln.upper().startswith("FABA"):
            continue
        desc.append(ln)
    out["description"] = " ".join(desc)[:1200] or None
    for j, ln in enumerate(lines):
        low = ln.lower().rstrip(":").strip()
        nxt = lines[j + 1] if j + 1 < len(lines) else ""
        if low == "contenuto adatto a":
            mm = re.match(r"(\d+)\s*[-–]\s*(\d+)", nxt)
            if mm:
                out["age"] = f"{mm.group(1)}-{mm.group(2)}"
        elif low == "durata":
            out["duration_text"] = nxt
    joined = "\n".join(lines)
    if "age" not in out:
        mm = re.search(r"adatto a:?\s*(\d+)\s*[-–]\s*(\d+)", joined, re.I)
        if mm:
            out["age"] = f"{mm.group(1)}-{mm.group(2)}"
    try:
        k = next(j for j, ln in enumerate(lines) if ln.lower() == "contenuti")
    except StopIteration:
        return out
    cur = None
    for ln in lines[k + 1:]:
        if ln.startswith("___"):
            break
        if ln.isupper() and ln.lower() in SECTION_NAMES:
            cur = {"name": ln.capitalize(), "items": []}
            out["sections"].append(cur)
        elif cur is not None:
            cur["items"].append(ln)
    out["sections"] = [s for s in out["sections"] if s["items"]]
    return out


DETAILS_VERSION = 2  # bump when the page parsers change


class DetailsCache:
    def __init__(self) -> None:
        self.path = _dir() / "details.json"
        self.data: dict[str, dict] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")

    def get(self, url: str) -> dict:
        hit = self.data.get(url)
        if hit and hit.get("v") == DETAILS_VERSION and (
                not hit.get("error") or time.time() - hit.get("ts", 0) < INDEX_TTL):
            return hit
        try:
            page = _get(url, timeout=30).decode("utf-8", "replace")
            info = _parse_myfaba(page) if "myfaba." in url else _parse_retailer(page)
        except Exception as e:
            log.info("details %s failed: %s", url, e)
            info = {"error": str(e), "sections": []}
        info["ts"] = time.time()
        info["v"] = DETAILS_VERSION
        self.data[url] = info
        return info
