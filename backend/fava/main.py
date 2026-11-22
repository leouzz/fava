from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import audiobooks, auth, bookinfo, db, importer, mki, uploads
from .config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("fava")

app = FastAPI(title="FAVA", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.middleware("http")(auth.middleware)
app.include_router(uploads.router)


@app.on_event("startup")
def _startup() -> None:
    db.init()
    with db.session() as conn:
        empty = conn.execute("SELECT COUNT(*) FROM albums").fetchone()[0] == 0
        row = conn.execute("SELECT value FROM meta WHERE key='asset_dir'").fetchone()
        moved = not empty and (row is None or row[0] != str(settings.asset_dir))
    if settings.import_on_start and (empty or moved or settings.import_always):
        importer.start_background()


# --------------------------------------------------------------------------- helpers

def _album_dict(r, fav: set[str] | None = None) -> dict:
    d = dict(r)
    d["credits"] = json.loads(d.get("credits") or "{}")
    d["contents"] = json.loads(d.get("contents") or "[]")
    d["sources"] = json.loads(d.get("sources") or "[]")
    d["online_fields"] = json.loads(d.get("online_fields") or "[]")
    d["cover"] = None
    if d.get("has_cover"):
        try:  # cache-busting: covers are cached by browsers for a day
            v = int((settings.covers_dir / f"{d['id']}.png").stat().st_mtime)
        except OSError:
            v = 0
        d["cover"] = f"/api/covers/{d['id']}.png?v={v}"
    if fav is not None:
        d["favorite"] = d["id"] in fav
    return d


def _favorites(conn, pid: int) -> set[str]:
    return {r[0] for r in conn.execute("SELECT album_id FROM profile_favorites WHERE profile_id=?", (pid,))}


def _profile_langs(conn, pid: int) -> list[str]:
    r = conn.execute("SELECT languages FROM profiles WHERE id=?", (pid,)).fetchone()
    return [x for x in (r[0] or "").split(",") if x] if r else []


def _lang_filter(conn, pid: int, alias: str = "a") -> tuple[str, list]:
    """SQL condition limiting albums to the profile's languages (unknown language stays visible)."""
    langs = _profile_langs(conn, pid)
    if not langs:
        return "", []
    return f"({alias}.language IS NULL OR {alias}.language IN ({','.join('?' * len(langs))}))", langs


def _book_filter(conn, pid: int, alias: str = "a") -> tuple[str, list]:
    """SQL condition hiding audiobooks the profile may not see (all | kids | none)."""
    r = conn.execute("SELECT audiobooks FROM profiles WHERE id=?", (pid,)).fetchone()
    mode = (r[0] if r else None) or "all"
    if mode == "none":
        return f"{alias}.kind <> 'audiobook'", []
    if mode == "kids":
        return f"({alias}.kind <> 'audiobook' OR {alias}.audience = 'kids')", []
    return "", []


def _visible(conn, pid: int, alias: str = "a", languages: bool = True) -> tuple[list[str], list]:
    where, args = [], []
    for fn in ((_lang_filter, _book_filter) if languages else (_book_filter,)):
        cond, cargs = fn(conn, pid, alias)
        if cond:
            where.append(cond)
            args += cargs
    return where, args


def _progress_map(conn, pid: int, kind: str | None = None) -> dict[str, dict]:
    """Resume point per album, with the seconds listened so far (whole album)."""
    sql = ("SELECT p.album_id, p.track_id, p.position, p.updated_at, t.idx, t.title, "
           "(SELECT COALESCE(SUM(t2.duration), 0) FROM tracks t2 WHERE t2.album_id=p.album_id AND t2.idx<t.idx) "
           "AS before FROM profile_progress p JOIN tracks t ON t.id=p.track_id "
           "JOIN albums a ON a.id=p.album_id WHERE p.profile_id=?")
    args: list = [pid]
    if kind:
        sql += " AND a.kind=?"
        args.append(kind)
    return {r["album_id"]: {"track_id": r["track_id"], "position": r["position"], "idx": r["idx"],
                            "title": r["title"], "listened": round(r["before"] + r["position"], 1),
                            "updated_at": r["updated_at"]}
            for r in conn.execute(sql, args)}


def profile_id(x_profile: str | None = Header(None)) -> int:
    """Active profile from the X-Profile header (falls back to the first profile)."""
    with db.session() as conn:
        if x_profile and x_profile.isdigit():
            r = conn.execute("SELECT id FROM profiles WHERE id=?", (int(x_profile),)).fetchone()
            if r:
                return r[0]
        r = conn.execute("SELECT id FROM profiles ORDER BY id LIMIT 1").fetchone()
        return r[0] if r else 0


def resolve_track(track_id: int) -> int:
    """Track ids change at every import: map ids still held by open players."""
    return importer.track_remap.get(track_id, track_id)


def _fts_query(q: str) -> str:
    words = re.findall(r"\w+", q, flags=re.UNICODE)
    return " ".join(f'"{w}"*' for w in words)


SORTS = {
    "id": "a.id",
    "title": "a.title COLLATE NOCASE",
    "duration": "a.duration DESC",
    "tracks": "a.track_count DESC",
    "recent": "a.added_at DESC, a.id DESC",
    "author": "a.subtitle IS NULL, a.subtitle COLLATE NOCASE, a.title COLLATE NOCASE",
}


# --------------------------------------------------------------------------- catalogue

@app.get("/api/config")
def config() -> dict:
    return {"public_url": settings.public_url or None, "prefer": settings.prefer}


# --------------------------------------------------------------------------- auth

class LoginIn(BaseModel):
    password: str


def _secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict:
    role = auth.role_of(request)
    return {
        "enabled": auth.enabled(),
        "required": bool(settings.password),
        "role": role,
        "admin_available": bool(settings.admin_password),
        "media_key": auth.media_key() if role else None,
    }


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request):
    ip = request.client.host if request.client else "?"
    auth.throttle(ip)
    role = auth.check_password(body.password)
    if not role:
        auth.failed(ip)
        raise HTTPException(401, "Password errata")
    auth.reset(ip)
    resp = JSONResponse({"role": role})
    resp.set_cookie(auth.COOKIE, auth.make_token(role), max_age=auth.SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=_secure(request), path="/")
    return resp


@app.post("/api/auth/check")
def check_admin(body: LoginIn, request: Request) -> dict:
    """Verify the parents' password without touching the session (leaving Easy mode)."""
    ip = request.client.host if request.client else "?"
    auth.throttle(ip)
    if auth.check_password(body.password) != "admin":
        auth.failed(ip)
        raise HTTPException(401, "Password errata")
    auth.reset(ip)
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/albums")
def albums(q: str = "", category: str = "", language: str = "", series: str = "",
           favorites: bool = False, lyrics: bool = False, status: str = "",
           hide_duplicates: bool = False, kind: str = "faba", audience: str = "",
           sort: str = "id", limit: int = 500, offset: int = 0, pid: int = Depends(profile_id)) -> dict:
    where, args = [], []
    if kind in ("faba", "audiobook"):
        where.append("a.kind = ?")
        args.append(kind)
    if q.strip():
        fq = _fts_query(q)
        if fq:
            where.append("a.id IN (SELECT album_id FROM search WHERE search MATCH ?)")
            args.append(fq)
    for col, val in (("category", category), ("language", language), ("series", series),
                     ("status", status), ("audience", audience)):
        if val:
            vals = val.split(",")
            where.append(f"a.{col} IN ({','.join('?' * len(vals))})")
            args += vals
    if favorites:
        where.append("a.id IN (SELECT album_id FROM profile_favorites WHERE profile_id=?)")
        args.append(pid)
    if lyrics:
        where.append("a.has_lyrics = 1")
    if hide_duplicates:
        where.append("a.duplicate_of IS NULL")
    with db.session() as conn:
        vw, va = _visible(conn, pid, languages=not language)
    where += vw
    args += va
    sql = "SELECT a.* FROM albums a"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {SORTS.get(sort, 'a.id')} LIMIT ? OFFSET ?"
    with db.session() as conn:
        fav = _favorites(conn, pid)
        rows = conn.execute(sql, (*args, limit, offset)).fetchall()
        items = [_album_dict(r, fav) for r in rows]
        if kind == "audiobook":
            prog = _progress_map(conn, pid, "audiobook")
            for d in items:
                d["progress"] = prog.get(d["id"])
        return {"items": items}


@app.get("/api/facets")
def facets(pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        cond, cargs = _lang_filter(conn, pid, "albums")
        extra = f" AND kind='faba'" + (f" AND {cond}" if cond else "")

        def count(col):
            return [{"value": r[0], "count": r[1]} for r in conn.execute(
                f"SELECT {col}, COUNT(*) FROM albums WHERE {col} IS NOT NULL AND duplicate_of IS NULL{extra} "
                f"GROUP BY {col} ORDER BY COUNT(*) DESC", cargs)]
        series = [s for s in count("series") if s["count"] > 1]
        stats = dict(conn.execute(
            "SELECT COUNT(*) AS albums, COALESCE(SUM(track_count),0) AS tracks, "
            f"COALESCE(SUM(duration),0) AS duration FROM albums WHERE 1=1{extra}", cargs).fetchone())
        last = conn.execute("SELECT value FROM meta WHERE key='last_import'").fetchone()
        stats["last_import"] = last[0] if last else None
        stats["favorites"] = conn.execute("SELECT COUNT(*) FROM profile_favorites WHERE profile_id=?",
                                          (pid,)).fetchone()[0]
        stats["duplicates"] = conn.execute(
            "SELECT COUNT(*) FROM albums WHERE duplicate_of IS NOT NULL AND kind='faba'").fetchone()[0]
        bw, ba = _visible(conn, pid)
        stats["audiobooks"] = conn.execute(
            "SELECT COUNT(*) FROM albums a WHERE " + " AND ".join(["a.kind='audiobook'", *bw]), ba).fetchone()[0]
        return {"categories": count("category"), "languages": count("language"),
                "series": series, "stats": stats}


@app.get("/api/albums/{album_id}")
def album(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        bw, ba = _visible(conn, pid, languages=False)
        r = conn.execute("SELECT * FROM albums a WHERE " + " AND ".join(["a.id=?", *bw]),
                         (album_id, *ba)).fetchone()
        if not r:
            raise HTTPException(404)
        d = _album_dict(r, _favorites(conn, pid))
        d["tracks"] = [
            {k: t[k] for k in ("id", "idx", "title", "title_source", "duration", "bitrate",
                               "source_kind", "is_extra", "valid")}
            | {"has_lyrics": bool(t["lyrics"]), "chapters": json.loads(t["chapters"]) if t["chapters"] else []}
            for t in conn.execute("SELECT * FROM tracks WHERE album_id=? ORDER BY idx", (album_id,))
        ]
        d["documents"] = [dict(x) | {"url": f"/api/documents/{x['id']}"} for x in conn.execute(
            "SELECT id, kind, name FROM documents WHERE album_id=? ORDER BY kind", (album_id,))]
        d["issues"] = [dict(x) for x in conn.execute(
            "SELECT level, code, message, track_idx FROM issues WHERE album_id=?", (album_id,))]
        root_id = d.get("duplicate_of") or album_id
        d["same_audio"] = [dict(x) for x in conn.execute(
            "SELECT id, title, language FROM albums WHERE (id=? OR duplicate_of=?) AND id<>? ORDER BY id",
            (root_id, root_id, album_id))]
        d["progress"] = _progress_map(conn, pid).get(album_id)
        return d


@app.get("/api/search")
def search(q: str, limit: int = 40, pid: int = Depends(profile_id)) -> dict:
    fq = _fts_query(q)
    if not fq:
        return {"albums": [], "tracks": []}
    with db.session() as conn:
        fav = _favorites(conn, pid)
        vw, va = _visible(conn, pid)
        allowed = None
        if vw:
            allowed = {r[0] for r in conn.execute(f"SELECT a.id FROM albums a WHERE {' AND '.join(vw)}", va)}
        album_ids = [r[0] for r in conn.execute(
            "SELECT album_id FROM search WHERE search MATCH ? AND kind IN ('album','credit','info') "
            "GROUP BY album_id ORDER BY MIN(rank) LIMIT ?", (fq, limit))]
        if allowed is not None:
            album_ids = [a for a in album_ids if a in allowed]
        albums = []
        for aid in album_ids:
            r = conn.execute("SELECT * FROM albums WHERE id=?", (aid,)).fetchone()
            if r:
                albums.append(_album_dict(r, fav))
        tracks = []
        for r in conn.execute(
                "SELECT s.kind, s.track_id, snippet(search, 3, '[', ']', '…', 8) AS snip, "
                "t.title, t.idx, t.duration, a.id AS album_id, a.title AS album_title, a.has_cover "
                "FROM search s JOIN tracks t ON t.id = s.track_id JOIN albums a ON a.id = s.album_id "
                "WHERE search MATCH ? AND s.kind IN ('track','lyrics') ORDER BY rank LIMIT ?",
                (fq, limit)):
            tracks.append(dict(r) | {"cover": f"/api/covers/{r['album_id']}.png" if r["has_cover"] else None})
        if allowed is not None:
            tracks = [t for t in tracks if t["album_id"] in allowed]
        seen, uniq = set(), []
        for t in tracks:
            if t["track_id"] not in seen:
                seen.add(t["track_id"])
                uniq.append(t)
        return {"albums": albums, "tracks": uniq}


@app.get("/api/tracks/{track_id}/lyrics")
def lyrics(track_id: int) -> dict:
    with db.session() as conn:
        r = conn.execute("SELECT lyrics FROM tracks WHERE id=?", (track_id,)).fetchone()
        if not r:
            raise HTTPException(404)
        return {"lyrics": r[0]}


@app.get("/api/covers/{album_id}.png")
def cover(album_id: str):
    if not (re.fullmatch(r"\d{4}", album_id) or audiobooks.is_audiobook_id(album_id)):
        raise HTTPException(404)
    p = settings.covers_dir / f"{album_id}.png"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/documents/{doc_id}")
def document(doc_id: int):
    with db.session() as conn:
        r = conn.execute("SELECT path, name FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not r or not Path(r["path"]).exists():
        raise HTTPException(404)
    return FileResponse(r["path"], media_type="application/pdf",
                        headers={"Content-Disposition": f"inline; filename*=UTF-8''{_quote(r['name'])}"})


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


# --------------------------------------------------------------------------- cover review

@app.get("/api/covers/candidates")
def cover_candidates() -> dict:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT c.*, a.title AS album_title, a.language, a.has_cover, a.cover_source "
            "FROM cover_candidates c JOIN albums a ON a.id=c.album_id "
            "WHERE c.status IN ('pending','auto') "
            "ORDER BY c.status='pending' DESC, c.score DESC, c.album_id").fetchall()
        return {"items": [{k: r[k] for k in r.keys() if k != "data"}
                          | {"image_url": f"/api/covers/candidates/{r['id']}.png" if r["image"] else None,
                             "source": bookinfo.SOURCE_NAME.get(r["source"], r["source"])} for r in rows]}


@app.get("/api/covers/candidates/{cid}.png")
def candidate_image(cid: int):
    with db.session() as conn:
        r = conn.execute("SELECT image FROM cover_candidates WHERE id=?", (cid,)).fetchone()
    p = settings.data_dir / "catalog" / "img" / (r["image"] if r else "")
    if not r or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


class ReviewIn(BaseModel):
    action: str  # accept | reject


@app.post("/api/covers/candidates/{cid}")
def review_candidate(cid: int, body: ReviewIn) -> dict:
    from .importer import _cover_color
    with db.session() as conn:
        c = conn.execute("SELECT * FROM cover_candidates WHERE id=?", (cid,)).fetchone()
        if not c:
            raise HTTPException(404)
        if audiobooks.is_audiobook_id(c["album_id"]):
            _review_book(conn, c, body.action)
            return {"ok": True}
        target = settings.covers_dir / f"{c['album_id']}.png"
        if body.action == "accept":
            src = settings.data_dir / "catalog" / "img" / c["image"]
            png = src.read_bytes()
            target.write_bytes(png)
            conn.execute("UPDATE albums SET has_cover=1, cover_source=?, color=? WHERE id=?",
                         ("catalog" if c["source"] == "myfaba" else "retailer", _cover_color(png), c["album_id"]))
            conn.execute("UPDATE cover_candidates SET status='accepted' WHERE id=?", (cid,))
            conn.execute("UPDATE cover_candidates SET status='rejected' WHERE album_id=? AND id<>? "
                         "AND status IN ('pending','auto')", (c["album_id"], cid))
        elif body.action == "reject":
            conn.execute("UPDATE cover_candidates SET status='rejected' WHERE id=?", (cid,))
            conn.execute("DELETE FROM album_links WHERE album_id=? AND url=?", (c["album_id"], c["product_url"]))
            if c["status"] in ("auto", "accepted"):  # undo an applied cover
                conn.execute("UPDATE albums SET has_cover=0, cover_source=NULL, color=NULL WHERE id=?",
                             (c["album_id"],))
                target.unlink(missing_ok=True)
        else:
            raise HTTPException(400, "action must be accept or reject")
    return {"ok": True}


def _review_book(conn, c, action: str) -> None:
    aid = c["album_id"]
    if action == "accept":
        r = bookinfo.Result.from_json(json.loads(c["data"] or "{}"))
        bookinfo.undo(conn, aid)  # replace what another match had filled
        if r.image_url and not c["image"]:
            img = bookinfo.image_file(r.image_url)
            if img:
                conn.execute("UPDATE cover_candidates SET image=? WHERE id=?", (img.name, c["id"]))
        bookinfo.apply(conn, aid, r)
        conn.execute("UPDATE cover_candidates SET status='accepted' WHERE id=?", (c["id"],))
        conn.execute("UPDATE cover_candidates SET status='rejected' WHERE album_id=? AND id<>? "
                     "AND status IN ('pending','auto','accepted')", (aid, c["id"]))
        conn.execute("DELETE FROM cover_candidates WHERE album_id=? AND status='option'", (aid,))
    elif action == "reject":
        if c["status"] in ("auto", "accepted"):
            bookinfo.undo(conn, aid)
        conn.execute("UPDATE cover_candidates SET status='rejected' WHERE id=?", (c["id"],))
    else:
        raise HTTPException(400, "action must be accept or reject")


class BookSearchIn(BaseModel):
    q: str | None = None  # free text; default: title + author


@app.post("/api/albums/{album_id}/online-search")
def book_search(album_id: str, body: BookSearchIn) -> dict:
    """Manual lookup from the book page: results are kept as "option" candidates."""
    if not audiobooks.is_audiobook_id(album_id):
        raise HTTPException(404)
    with db.session() as conn:
        a = conn.execute("SELECT title, subtitle, language FROM albums WHERE id=?", (album_id,)).fetchone()
    if not a:
        raise HTTPException(404)
    cache = bookinfo.Cache()
    try:
        if body.q and body.q.strip():
            q = body.q.strip()[:200]
            results = bookinfo.search(cache, q, None, a["language"])
            for r in results:  # rank against the book, not the free text
                ts, au = bookinfo.score(r, a["title"], a["subtitle"])
                r.score = round(max(r.score, ts * (au if au >= 0 else 0.8)), 3)
            results.sort(key=lambda r: -r.score)
        else:
            results = bookinfo.search(cache, a["title"], a["subtitle"], a["language"])
    finally:
        cache.save()
    results = results[:12]
    with db.session() as conn:
        conn.execute("DELETE FROM cover_candidates WHERE album_id=? AND status='option'", (album_id,))
        current = {r[0]: r[1] for r in conn.execute(
            "SELECT product_url, status FROM cover_candidates WHERE album_id=?", (album_id,))}
        items = []
        for r in results:
            status = current.get(r.url)
            cid = bookinfo.store_candidate(conn, album_id, r, status or "option", None)
            items.append({"id": cid, "source": r.source, "source_name": bookinfo.SOURCE_NAME[r.source],
                          "title": r.title, "author": r.author, "year": r.year, "genre": r.genre,
                          "thumb": r.thumb_url, "url": r.url, "score": r.score, "status": status,
                          "description": (r.description or "")[:300] or None})
    return {"items": items}


@app.post("/api/albums/{album_id}/online-apply/{cid}")
def book_apply(album_id: str, cid: int) -> dict:
    with db.session() as conn:
        c = conn.execute("SELECT * FROM cover_candidates WHERE id=? AND album_id=?", (cid, album_id)).fetchone()
        if not c or not audiobooks.is_audiobook_id(album_id):
            raise HTTPException(404)
        r = bookinfo.Result.from_json(json.loads(c["data"] or "{}"))
        if r.source == "openlibrary" and not r.description:
            cache = bookinfo.Cache()
            try:
                bookinfo.complete(cache, r)
            finally:
                cache.save()
            conn.execute("UPDATE cover_candidates SET data=? WHERE id=?", (json.dumps(r.to_json()), cid))
            c = conn.execute("SELECT * FROM cover_candidates WHERE id=?", (cid,)).fetchone()
        _review_book(conn, c, "accept")
    return {"ok": True}


@app.post("/api/albums/{album_id}/online-clear")
def book_clear(album_id: str) -> dict:
    """Forget the online match: what it filled goes away and it is not searched again."""
    if not audiobooks.is_audiobook_id(album_id):
        raise HTTPException(404)
    with db.session() as conn:
        bookinfo.undo(conn, album_id)
        conn.execute("UPDATE cover_candidates SET status='rejected' WHERE album_id=? "
                     "AND status IN ('auto','accepted','pending')", (album_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- streaming

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


MEDIA_TYPES = {"mki": "audio/mpeg", "mp3": "audio/mpeg", "m4b": "audio/mp4", "m4a": "audio/mp4"}


@app.api_route("/api/stream/{track_id}", methods=["GET", "HEAD"])
def stream(track_id: int, request: Request):
    track_id = resolve_track(track_id)
    with db.session() as conn:
        r = conn.execute("SELECT source_kind, source_path FROM tracks WHERE id=?", (track_id,)).fetchone()
    if not r:
        raise HTTPException(404)
    path = Path(r["source_path"])
    if not path.exists():
        raise HTTPException(410, "file non più presente: rilancia l'import")
    size = path.stat().st_size
    start, end, status = 0, size - 1, 200
    rng = request.headers.get("range")
    if rng:
        m = _RANGE.match(rng.strip())
        if m:
            s, e = m.groups()
            if s == "" and e:
                start = max(0, size - int(e))
            else:
                start = int(s or 0)
                end = min(int(e), size - 1) if e else size - 1
            if start >= size or start > end:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
            status = 206
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",  # Chromecast receiver fetches cross-origin
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    media_type = MEDIA_TYPES.get(r["source_kind"], "audio/mpeg")
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type=media_type)

    if r["source_kind"] == "mki":
        body = mki.iter_decoded(path, start, end)
    else:
        def body_gen():
            with open(path, "rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    buf = fh.read(min(256 * 1024, left))
                    if not buf:
                        break
                    left -= len(buf)
                    yield buf
        body = body_gen()
    return StreamingResponse(body, status_code=status, headers=headers, media_type=media_type)


# --------------------------------------------------------------------------- user state

@app.post("/api/favorites/{album_id}")
def add_favorite(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        conn.execute("INSERT OR IGNORE INTO profile_favorites(profile_id, album_id) VALUES(?,?)", (pid, album_id))
    return {"ok": True}


@app.delete("/api/favorites/{album_id}")
def del_favorite(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        conn.execute("DELETE FROM profile_favorites WHERE profile_id=? AND album_id=?", (pid, album_id))
    return {"ok": True}


class ProgressIn(BaseModel):
    album_id: str
    track_id: int
    position: float


@app.put("/api/progress")
def put_progress(p: ProgressIn, pid: int = Depends(profile_id)) -> dict:
    p.track_id = resolve_track(p.track_id)
    with db.session() as conn:
        conn.execute("INSERT INTO profile_progress(profile_id, album_id, track_id, position, updated_at) "
                     "VALUES(?,?,?,?,datetime('now')) ON CONFLICT(profile_id, album_id) DO UPDATE SET "
                     "track_id=excluded.track_id, position=excluded.position, updated_at=excluded.updated_at",
                     (pid, p.album_id, p.track_id, p.position))
    return {"ok": True}


class BookmarkIn(BaseModel):
    album_id: str
    track_id: int
    position: float
    note: str | None = None


class BookmarkNoteIn(BaseModel):
    note: str | None = None


def _note(s: str | None) -> str | None:
    return (s or "").strip()[:500] or None


@app.get("/api/bookmarks")
def bookmarks(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT b.id, b.album_id, b.track_idx, b.position, b.note, b.created_at, t.id AS track_id "
            "FROM profile_bookmarks b LEFT JOIN tracks t ON t.album_id=b.album_id AND t.idx=b.track_idx "
            "WHERE b.profile_id=? AND b.album_id=? ORDER BY b.track_idx, b.position", (pid, album_id)).fetchall()
        return {"items": [dict(r) for r in rows if r["track_id"] is not None]}


@app.post("/api/bookmarks")
def add_bookmark(b: BookmarkIn, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        t = conn.execute("SELECT idx FROM tracks WHERE id=? AND album_id=?",
                         (resolve_track(b.track_id), b.album_id)).fetchone()
        if not t:
            raise HTTPException(404, "traccia non trovata")
        if conn.execute("SELECT COUNT(*) FROM profile_bookmarks WHERE profile_id=? AND album_id=?",
                        (pid, b.album_id)).fetchone()[0] >= 200:
            raise HTTPException(400, "massimo 200 segnalibri per libro")
        cur = conn.execute("INSERT INTO profile_bookmarks(profile_id, album_id, track_idx, position, note) "
                           "VALUES(?,?,?,?,?)", (pid, b.album_id, t[0], max(0.0, b.position), _note(b.note)))
        return {"id": cur.lastrowid}


@app.put("/api/bookmarks/{bid}")
def edit_bookmark(bid: int, b: BookmarkNoteIn, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        if not conn.execute("UPDATE profile_bookmarks SET note=? WHERE id=? AND profile_id=?",
                            (_note(b.note), bid, pid)).rowcount:
            raise HTTPException(404)
    return {"ok": True}


@app.delete("/api/bookmarks/{bid}")
def del_bookmark(bid: int, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        conn.execute("DELETE FROM profile_bookmarks WHERE id=? AND profile_id=?", (bid, pid))
    return {"ok": True}


@app.delete("/api/progress/{album_id}")
def del_progress(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        conn.execute("DELETE FROM profile_progress WHERE profile_id=? AND album_id=?", (pid, album_id))
    return {"ok": True}


@app.get("/api/continue")
def continue_listening(limit: int = 12, kind: str = "faba", pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        fav = _favorites(conn, pid)
        vw, va = _visible(conn, pid, languages=False)
        prog = _progress_map(conn, pid, kind if kind in ("faba", "audiobook") else None)
        ids = sorted(prog, key=lambda k: prog[k]["updated_at"] or "", reverse=True)
        out = []
        for aid in ids:
            r = conn.execute("SELECT * FROM albums a WHERE " + " AND ".join(["a.id=?", *vw]),
                             (aid, *va)).fetchone()
            if not r:
                continue
            # finished audiobooks leave "continue listening"
            if r["kind"] == "audiobook" and prog[aid]["listened"] >= (r["duration"] or 0) - 30:
                continue
            d = _album_dict(r, fav)
            d["progress"] = prog[aid]
            out.append(d)
            if len(out) >= limit:
                break
        return {"items": out}


class AudienceIn(BaseModel):
    audience: str | None  # kids | adults | None (unknown)


@app.post("/api/albums/{album_id}/audience")
def set_audience(album_id: str, body: AudienceIn) -> dict:
    if body.audience not in ("kids", "adults", None) or not audiobooks.is_audiobook_id(album_id):
        raise HTTPException(400)
    with db.session() as conn:
        if not conn.execute("UPDATE albums SET audience=? WHERE id=?", (body.audience, album_id)).rowcount:
            raise HTTPException(404)
        if body.audience:
            conn.execute("INSERT INTO album_overrides(album_id, audience) VALUES(?,?) "
                         "ON CONFLICT(album_id) DO UPDATE SET audience=excluded.audience", (album_id, body.audience))
        else:
            conn.execute("DELETE FROM album_overrides WHERE album_id=?", (album_id,))
    return {"ok": True}


# --------------------------------------------------------------------------- profiles

AVATAR_RE = re.compile(r"^(face:[a-z]{2,16}|figure:\d{4})$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ProfileIn(BaseModel):
    name: str
    avatar: str = "face:bear"
    color: str = "#ff6b5e"
    languages: list[str] = []
    audiobooks: str = "all"  # all | kids | none
    easy: bool = False       # Easy mode: NFC cards and big buttons, leaving needs the parents' password


def _check_profile(p: ProfileIn) -> ProfileIn:
    p.name = p.name.strip()[:24]
    if not p.name:
        raise HTTPException(400, "nome obbligatorio")
    if not AVATAR_RE.match(p.avatar) or not COLOR_RE.match(p.color):
        raise HTTPException(400, "avatar o colore non validi")
    p.languages = sorted({x for x in p.languages if re.fullmatch(r"[a-z]{2}", x)})
    if p.audiobooks not in ("all", "kids", "none"):
        raise HTTPException(400, "audiolibri: all, kids o none")
    return p


def _profiles(conn) -> list[dict]:
    return [dict(r) | {"favorites": r["favs"], "languages": [x for x in (r["languages"] or "").split(",") if x],
                       "easy": bool(r["easy"])}
            for r in conn.execute(
        "SELECT p.id, p.name, p.avatar, p.color, p.languages, p.audiobooks, p.easy, "
        "(SELECT COUNT(*) FROM profile_favorites f WHERE f.profile_id=p.id) AS favs "
        "FROM profiles p ORDER BY p.id")]


@app.get("/api/languages")
def languages() -> dict:
    """All languages in the library (unfiltered), for the profile editor."""
    with db.session() as conn:
        return {"items": [{"value": r[0], "count": r[1]} for r in conn.execute(
            "SELECT language, COUNT(*) FROM albums WHERE language IS NOT NULL AND duplicate_of IS NULL "
            "GROUP BY language ORDER BY COUNT(*) DESC")]}


@app.get("/api/profiles")
def list_profiles() -> dict:
    with db.session() as conn:
        return {"items": _profiles(conn)}


@app.post("/api/profiles")
def create_profile(p: ProfileIn) -> dict:
    p = _check_profile(p)
    with db.session() as conn:
        if conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] >= 12:
            raise HTTPException(400, "massimo 12 profili")
        cur = conn.execute("INSERT INTO profiles(name, avatar, color, languages, audiobooks, easy) "
                           "VALUES(?,?,?,?,?,?)",
                           (p.name, p.avatar, p.color, ",".join(p.languages) or None, p.audiobooks, int(p.easy)))
        return {"id": cur.lastrowid}


@app.put("/api/profiles/{pid}")
def update_profile(pid: int, p: ProfileIn) -> dict:
    p = _check_profile(p)
    with db.session() as conn:
        if not conn.execute("UPDATE profiles SET name=?, avatar=?, color=?, languages=?, audiobooks=?, easy=? "
                            "WHERE id=?", (p.name, p.avatar, p.color, ",".join(p.languages) or None,
                                           p.audiobooks, int(p.easy), pid)).rowcount:
            raise HTTPException(404)
    return {"ok": True}


@app.delete("/api/profiles/{pid}")
def delete_profile(pid: int) -> dict:
    with db.session() as conn:
        if conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] <= 1:
            raise HTTPException(400, "serve almeno un profilo")
        conn.execute("DELETE FROM profiles WHERE id=?", (pid,))
    return {"ok": True}


# --------------------------------------------------------------------------- NFC cards

def _nfc_uid(uid: str) -> str:
    u = re.sub(r"[^0-9a-f]", "", uid.lower())
    if not 4 <= len(u) <= 32:
        raise HTTPException(400, "codice tessera non valido")
    return u


class NfcTagIn(BaseModel):
    album_id: str


@app.get("/api/nfc/tags")
def nfc_tags() -> dict:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT n.uid, n.target_kind, n.target_id, n.created_at, a.id AS album_id, a.kind, a.title, "
            "a.has_cover, a.color, a.category FROM nfc_tags n LEFT JOIN albums a ON a.id=n.target_id "
            "ORDER BY n.created_at DESC").fetchall()
        items = []
        for r in rows:
            d = {"uid": r["uid"], "target_kind": r["target_kind"], "target_id": r["target_id"],
                 "created_at": r["created_at"], "album": None}
            if r["album_id"]:
                d["album"] = {k: v for k, v in _album_dict(
                    {"id": r["album_id"], "kind": r["kind"], "title": r["title"], "has_cover": r["has_cover"],
                     "color": r["color"], "category": r["category"]}).items()
                    if k in ("id", "kind", "title", "cover", "color", "category")}
            items.append(d)
        return {"items": items}


@app.put("/api/nfc/tags/{uid}")
def pair_nfc_tag(uid: str, body: NfcTagIn) -> dict:
    uid = _nfc_uid(uid)
    with db.session() as conn:
        if not conn.execute("SELECT 1 FROM albums WHERE id=?", (body.album_id,)).fetchone():
            raise HTTPException(404, "album non trovato")
        conn.execute("INSERT INTO nfc_tags(uid, target_kind, target_id) VALUES(?, 'album', ?) "
                     "ON CONFLICT(uid) DO UPDATE SET target_kind='album', target_id=excluded.target_id, "
                     "created_at=datetime('now')", (uid, body.album_id))
    return {"ok": True, "uid": uid}


@app.delete("/api/nfc/tags/{uid}")
def unpair_nfc_tag(uid: str) -> dict:
    with db.session() as conn:
        conn.execute("DELETE FROM nfc_tags WHERE uid=?", (_nfc_uid(uid),))
    return {"ok": True}


# --------------------------------------------------------------------------- import / verify

@app.post("/api/import")
def start_import() -> dict:
    started = importer.start_background()
    return {"started": started, "running": importer.state.running}


@app.get("/api/import/status")
def import_status() -> dict:
    s = importer.state
    return {"running": s.running, "phase": s.phase, "done": s.done, "total": s.total,
            "message": s.message, "log": s.log[-80:], "stats": s.stats,
            "started_at": s.started_at, "finished_at": s.finished_at,
            "asset_dir": str(settings.asset_dir)}


@app.get("/api/issues")
def issues() -> dict:
    with db.session() as conn:
        rows = conn.execute(
            "SELECT i.*, a.title AS album_title FROM issues i LEFT JOIN albums a ON a.id=i.album_id "
            "ORDER BY CASE i.level WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.album_id").fetchall()
        summary = {r[0]: r[1] for r in conn.execute("SELECT level, COUNT(*) FROM issues GROUP BY level")}
        sources = {r[0]: r[1] for r in conn.execute(
            "SELECT source_kind, COUNT(*) FROM tracks GROUP BY source_kind")}
        titles = {r[0]: r[1] for r in conn.execute(
            "SELECT title_source, COUNT(*) FROM tracks GROUP BY title_source")}
        return {"items": [dict(r) for r in rows], "summary": summary,
                "track_sources": sources, "title_sources": titles}


# --------------------------------------------------------------------------- frontend

if settings.static_dir.exists():
    app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = (settings.static_dir / full_path).resolve()
        if full_path and candidate.is_file() and settings.static_dir.resolve() in candidate.parents:
            if full_path in ("sw.js", "manifest.webmanifest"):
                return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
            return FileResponse(candidate)
        return FileResponse(settings.static_dir / "index.html",
                            headers={"Cache-Control": "no-cache"})
else:
    @app.get("/")
    def root():
        return JSONResponse({"fava": "api running", "frontend": "not built"})


def run() -> None:  # entry point for `python -m fava`
    import uvicorn
    uvicorn.run("fava.main:app", host=os.environ.get("HOST", "0.0.0.0"),
                port=int(os.environ.get("PORT", "8080")), proxy_headers=True,
                forwarded_allow_ips="*")
