"""Backup of what can't be rebuilt from the audio files.

The zip holds:

- ``fava-backup.json``: the choices made from the UI on the catalogue: product
  pages linked to each figure (by hand or found automatically), covers accepted
  or discarded in the review, kids / adults marks on audiobooks;
- ``user.db``: profiles (with PINs), NFC cards, favourites, progress, bookmarks;
- ``covers-manual/``: pictures uploaded by hand;
- ``catalog/img/``: the online pictures of the accepted covers.

Restoring writes them back and starts an import, which applies everything again.
The audio itself (asset folder, uploaded backups and audiobooks) is not included.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from . import db, importer
from .config import settings
from .uploads import manual_covers_dir

router = APIRouter()

VERSION = 1
MANIFEST = "fava-backup.json"
IMG_RE = re.compile(r"^[\w.-]{1,80}\.(png|jpe?g|webp)$", re.I)
MAX_SIZE = 500 * 1024 * 1024


def _img_dir() -> Path:
    return settings.data_dir / "catalog" / "img"


@router.get("/api/backup")
def download_backup() -> Response:
    with db.session() as conn:
        links = [dict(r) for r in conn.execute("SELECT album_id, source, url, method FROM album_links")]
        candidates = [dict(r) for r in conn.execute(
            "SELECT album_id, source, product_url, product_name, image, score, status, data "
            "FROM cover_candidates WHERE status IN ('accepted', 'rejected')")]
        overrides = [dict(r) for r in conn.execute("SELECT album_id, audience FROM album_overrides")]
        albums = {r[0]: r[1] for r in conn.execute("SELECT id, title FROM albums")}
    manifest = {
        "app": "fava", "version": VERSION, "created_at": int(time.time()),
        "album_links": links, "cover_candidates": candidates, "album_overrides": overrides,
        "album_titles": albums,  # only to make the file readable
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=1))
        user_db = settings.data_dir / "user.db"
        if user_db.exists():
            with tempfile.TemporaryDirectory() as tmp:
                copy = Path(tmp) / "user.db"
                src, dst = sqlite3.connect(user_db), sqlite3.connect(copy)
                try:
                    src.backup(dst)  # consistent copy while the app is running
                finally:
                    src.close()
                    dst.close()
                z.write(copy, "user.db")
        manual = manual_covers_dir()
        if manual.is_dir():
            for f in sorted(manual.iterdir()):
                if f.is_file() and IMG_RE.match(f.name):
                    z.write(f, f"covers-manual/{f.name}")
        for name in sorted({c["image"] for c in candidates if c["status"] == "accepted" and c["image"]}):
            f = _img_dir() / name
            if IMG_RE.match(name) and f.is_file():
                z.write(f, f"catalog/img/{name}")
    stamp = time.strftime("%Y%m%d-%H%M")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="fava-backup-{stamp}.zip"'})


@router.post("/api/backup")
async def restore_backup(request: Request) -> dict:
    if importer.state.running:
        raise HTTPException(409, "Import in corso: riprova quando è finito")
    data = await request.body()
    if len(data) > MAX_SIZE:
        raise HTTPException(400, "file troppo grande")
    return await run_in_threadpool(_restore, data)  # keep the event loop (audio streams) free


def _restore(data: bytes) -> dict:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        manifest = json.loads(z.read(MANIFEST))
    except (zipfile.BadZipFile, KeyError, ValueError):
        raise HTTPException(400, "Non è un backup di FAVA")
    if manifest.get("app") != "fava" or manifest.get("version", 0) > VERSION:
        raise HTTPException(400, "Backup non riconosciuto o di una versione più recente")

    images = 0
    for name in z.namelist():
        folder, _, base = name.rpartition("/")
        target = {"covers-manual": manual_covers_dir(), "catalog/img": _img_dir()}.get(folder)
        if target is None or not IMG_RE.match(base):
            continue  # only known folders and plain image names: no path tricks
        target.mkdir(parents=True, exist_ok=True)
        (target / base).write_bytes(z.read(name))
        images += 1

    profiles = None
    if "user.db" in z.namelist():
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "user.db"
            copy.write_bytes(z.read("user.db"))
            src = sqlite3.connect(copy)
            try:
                try:
                    profiles = src.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]
                except sqlite3.DatabaseError:
                    raise HTTPException(400, "user.db nel backup non valido")
                dst = sqlite3.connect(settings.data_dir / "user.db", timeout=30)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
        db.init()  # columns added by newer versions

    with db.session() as conn:
        for r in manifest.get("cover_candidates", []):
            conn.execute(
                "INSERT INTO cover_candidates(album_id, source, product_url, product_name, image, score, status, data) "
                "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(album_id, product_url) DO UPDATE SET "
                "source=excluded.source, product_name=excluded.product_name, image=excluded.image, "
                "score=excluded.score, status=excluded.status, data=excluded.data",
                (r["album_id"], r["source"], r["product_url"], r.get("product_name"), r.get("image") or "",
                 r.get("score"), r["status"], r.get("data")))
        for r in manifest.get("album_links", []):
            importer._link(conn, r["album_id"], r["source"], r["url"], r.get("method"))
        for r in manifest.get("album_overrides", []):
            conn.execute("INSERT INTO album_overrides(album_id, audience) VALUES(?,?) "
                         "ON CONFLICT(album_id) DO UPDATE SET audience=excluded.audience",
                         (r["album_id"], r.get("audience")))
    importer.start_background()  # applies covers, links and details again
    return {"ok": True, "links": len(manifest.get("album_links", [])),
            "covers": sum(1 for c in manifest.get("cover_candidates", []) if c["status"] == "accepted"),
            "images": images, "profiles": profiles}
