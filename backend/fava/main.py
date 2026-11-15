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

from . import auth, db, importer, mki, uploads
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


def profile_id(x_profile: str | None = Header(None)) -> int:
    """Active profile from the X-Profile header (falls back to the first profile)."""
    with db.session() as conn:
        if x_profile and x_profile.isdigit():
            r = conn.execute("SELECT id FROM profiles WHERE id=?", (int(x_profile),)).fetchone()
            if r:
                return r[0]
        r = conn.execute("SELECT id FROM profiles ORDER BY id LIMIT 1").fetchone()
        return r[0] if r else 0


def _fts_query(q: str) -> str:
    words = re.findall(r"\w+", q, flags=re.UNICODE)
    return " ".join(f'"{w}"*' for w in words)


SORTS = {
    "id": "a.id",
    "title": "a.title COLLATE NOCASE",
    "duration": "a.duration DESC",
    "tracks": "a.track_count DESC",
    "recent": "a.added_at DESC, a.id DESC",
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


@app.post("/api/auth/logout")
def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/albums")
def albums(q: str = "", category: str = "", language: str = "", series: str = "",
           favorites: bool = False, lyrics: bool = False, status: str = "",
           hide_duplicates: bool = False,
           sort: str = "id", limit: int = 500, offset: int = 0, pid: int = Depends(profile_id)) -> dict:
    where, args = [], []
    if q.strip():
        fq = _fts_query(q)
        if fq:
            where.append("a.id IN (SELECT album_id FROM search WHERE search MATCH ?)")
            args.append(fq)
    for col, val in (("category", category), ("language", language), ("series", series),
                     ("status", status)):
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
    if not language:
        with db.session() as conn:
            cond, cargs = _lang_filter(conn, pid)
        if cond:
            where.append(cond)
            args += cargs
    sql = "SELECT a.* FROM albums a"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {SORTS.get(sort, 'a.id')} LIMIT ? OFFSET ?"
    with db.session() as conn:
        fav = _favorites(conn, pid)
        rows = conn.execute(sql, (*args, limit, offset)).fetchall()
        return {"items": [_album_dict(r, fav) for r in rows]}


@app.get("/api/facets")
def facets(pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        cond, cargs = _lang_filter(conn, pid, "albums")
        extra = f" AND {cond}" if cond else ""

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
            "SELECT COUNT(*) FROM albums WHERE duplicate_of IS NOT NULL").fetchone()[0]
        return {"categories": count("category"), "languages": count("language"),
                "series": series, "stats": stats}


@app.get("/api/albums/{album_id}")
def album(album_id: str, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        r = conn.execute("SELECT * FROM albums WHERE id=?", (album_id,)).fetchone()
        if not r:
            raise HTTPException(404)
        d = _album_dict(r, _favorites(conn, pid))
        d["tracks"] = [
            {k: t[k] for k in ("id", "idx", "title", "title_source", "duration", "bitrate",
                               "source_kind", "is_extra", "valid")} | {"has_lyrics": bool(t["lyrics"])}
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
        p = conn.execute("SELECT track_id, position FROM profile_progress WHERE profile_id=? AND album_id=?",
                         (pid, album_id)).fetchone()
        d["progress"] = dict(p) if p else None
        return d


@app.get("/api/search")
def search(q: str, limit: int = 40, pid: int = Depends(profile_id)) -> dict:
    fq = _fts_query(q)
    if not fq:
        return {"albums": [], "tracks": []}
    with db.session() as conn:
        fav = _favorites(conn, pid)
        cond, cargs = _lang_filter(conn, pid)
        allowed = None
        if cond:
            allowed = {r[0] for r in conn.execute(f"SELECT a.id FROM albums a WHERE {cond}", cargs)}
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
    if not re.fullmatch(r"\d{4}", album_id):
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
        return {"items": [dict(r) | {"image_url": f"/api/covers/candidates/{r['id']}.png"} for r in rows]}


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


# --------------------------------------------------------------------------- streaming

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@app.api_route("/api/stream/{track_id}", methods=["GET", "HEAD"])
def stream(track_id: int, request: Request):
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
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type="audio/mpeg")

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
    return StreamingResponse(body, status_code=status, headers=headers, media_type="audio/mpeg")


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
    with db.session() as conn:
        conn.execute("INSERT INTO profile_progress(profile_id, album_id, track_id, position, updated_at) "
                     "VALUES(?,?,?,?,datetime('now')) ON CONFLICT(profile_id, album_id) DO UPDATE SET "
                     "track_id=excluded.track_id, position=excluded.position, updated_at=excluded.updated_at",
                     (pid, p.album_id, p.track_id, p.position))
    return {"ok": True}


@app.get("/api/continue")
def continue_listening(limit: int = 12, pid: int = Depends(profile_id)) -> dict:
    with db.session() as conn:
        fav = _favorites(conn, pid)
        rows = conn.execute(
            "SELECT a.*, p.track_id AS p_track, p.position AS p_pos, t.idx AS p_idx, t.title AS p_title "
            "FROM profile_progress p JOIN albums a ON a.id=p.album_id JOIN tracks t ON t.id=p.track_id "
            "WHERE p.profile_id=? ORDER BY p.updated_at DESC LIMIT ?", (pid, limit)).fetchall()
        out = []
        for r in rows:
            d = _album_dict(r, fav)
            d["progress"] = {"track_id": r["p_track"], "position": r["p_pos"],
                             "idx": r["p_idx"], "title": r["p_title"]}
            out.append(d)
        return {"items": out}


# --------------------------------------------------------------------------- profiles

AVATAR_RE = re.compile(r"^(face:[a-z]{2,16}|figure:\d{4})$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ProfileIn(BaseModel):
    name: str
    avatar: str = "face:bear"
    color: str = "#ff6b5e"
    languages: list[str] = []


def _check_profile(p: ProfileIn) -> ProfileIn:
    p.name = p.name.strip()[:24]
    if not p.name:
        raise HTTPException(400, "nome obbligatorio")
    if not AVATAR_RE.match(p.avatar) or not COLOR_RE.match(p.color):
        raise HTTPException(400, "avatar o colore non validi")
    p.languages = sorted({x for x in p.languages if re.fullmatch(r"[a-z]{2}", x)})
    return p


def _profiles(conn) -> list[dict]:
    return [dict(r) | {"favorites": r["favs"], "languages": [x for x in (r["languages"] or "").split(",") if x]}
            for r in conn.execute(
        "SELECT p.id, p.name, p.avatar, p.color, p.languages, "
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
        cur = conn.execute("INSERT INTO profiles(name, avatar, color, languages) VALUES(?,?,?,?)",
                           (p.name, p.avatar, p.color, ",".join(p.languages) or None))
        return {"id": cur.lastrowid}


@app.put("/api/profiles/{pid}")
def update_profile(pid: int, p: ProfileIn) -> dict:
    p = _check_profile(p)
    with db.session() as conn:
        if not conn.execute("UPDATE profiles SET name=?, avatar=?, color=?, languages=? WHERE id=?",
                            (p.name, p.avatar, p.color, ",".join(p.languages) or None, pid)).rowcount:
            raise HTTPException(404)
    return {"ok": True}


@app.delete("/api/profiles/{pid}")
def delete_profile(pid: int) -> dict:
    with db.session() as conn:
        if conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] <= 1:
            raise HTTPException(400, "serve almeno un profilo")
        conn.execute("DELETE FROM profiles WHERE id=?", (pid,))
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
