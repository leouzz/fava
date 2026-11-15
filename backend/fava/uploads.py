"""Backups and covers uploaded from the browser.

Files are streamed straight to ``<data>/uploads/<batch>/<relative path>``
(the asset folder is mounted read-only in Docker). ZIP archives are extracted
in place with path-traversal and size checks. The importer scans the upload
folder together with the asset folder.
"""

from __future__ import annotations

import io
import re
import shutil
import time
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, HTTPException, Request

from . import db
from .config import settings

router = APIRouter()

ALLOWED_EXT = {".mki", ".mp3", ".pdf", ".csv", ".txt", ".zip", ".png", ".jpg", ".jpeg", ".webp"}
RE_CP = re.compile(r"^CP\d{1,3}$", re.I)
RE_BATCH = re.compile(r"^[\w-]{1,40}$")
MAX_ZIP_TOTAL = 32 * 1024**3  # refuse archives that expand beyond 32 GB


def upload_root() -> Path:
    return settings.data_dir / "uploads"


def manual_covers_dir() -> Path:
    return settings.data_dir / "covers-manual"


def _safe_rel(path: str) -> PurePosixPath:
    p = PurePosixPath(path.replace("\\", "/").lstrip("/"))
    if not p.parts or any(part in ("..", "") or part.startswith(".") for part in p.parts) or len(p.parts) > 6:
        raise HTTPException(400, f"percorso non valido: {path}")
    if any(re.search(r"[\x00-\x1f<>:\"|?*]", part) for part in p.parts):
        raise HTTPException(400, f"caratteri non validi: {path}")
    name = p.name
    if not (RE_CP.match(name) or PurePosixPath(name).suffix.lower() in ALLOWED_EXT):
        raise HTTPException(400, f"tipo di file non supportato: {name}")
    return p


def _extract_zip(zpath: Path, dest: Path) -> int:
    n = 0
    with zipfile.ZipFile(zpath) as z:
        total = sum(i.file_size for i in z.infolist())
        if total > MAX_ZIP_TOTAL:
            raise HTTPException(400, "archivio troppo grande")
        for info in z.infolist():
            if info.is_dir():
                continue
            try:
                rel = _safe_rel(info.filename)
            except HTTPException:
                continue  # skip unsupported entries (e.g. __MACOSX, .DS_Store)
            if rel.suffix.lower() == ".zip":
                continue
            target = dest.joinpath(*rel.parts)
            if dest.resolve() not in target.resolve().parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            n += 1
    return n


@router.put("/api/uploads/file")
async def upload_file(request: Request, batch: str, path: str) -> dict:
    if not RE_BATCH.match(batch):
        raise HTTPException(400, "batch non valido")
    rel = _safe_rel(path)
    dest_dir = upload_root() / batch
    target = dest_dir.joinpath(*rel.parts)
    if dest_dir.resolve() not in target.resolve().parents:
        raise HTTPException(400, "percorso non valido")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".part")
    size = 0
    with open(tmp, "wb") as out:
        async for chunk in request.stream():
            out.write(chunk)
            size += len(chunk)
    tmp.replace(target)
    extracted = 0
    if target.suffix.lower() == ".zip":
        try:
            extracted = _extract_zip(target, dest_dir / target.stem)
        except zipfile.BadZipFile:
            raise HTTPException(400, "ZIP non valido")
        finally:
            target.unlink(missing_ok=True)
    return {"ok": True, "size": size, "extracted": extracted}


@router.get("/api/uploads")
def list_uploads() -> dict:
    root = upload_root()
    items = []
    if root.is_dir():
        for d in sorted(root.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            files = [f for f in d.rglob("*") if f.is_file()]
            items.append({"batch": d.name, "files": len(files), "bytes": sum(f.stat().st_size for f in files),
                          "figures": sorted({p.name for p in d.rglob("K[0-9][0-9][0-9][0-9]") if p.is_dir()}),
                          "modified": int(d.stat().st_mtime)})
    return {"items": items}


@router.delete("/api/uploads/{batch}")
def delete_upload(batch: str) -> dict:
    if not RE_BATCH.match(batch):
        raise HTTPException(400)
    d = upload_root() / batch
    if d.is_dir():
        shutil.rmtree(d)
    return {"ok": True}


@router.post("/api/albums/{album_id}/cover")
async def upload_cover(album_id: str, request: Request) -> dict:
    from PIL import Image

    from .importer import _cover_color

    if not re.fullmatch(r"\d{4}", album_id):
        raise HTTPException(404)
    data = await request.body()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "immagine troppo grande")
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGBA")
    except Exception:
        raise HTTPException(400, "immagine non valida")
    img.thumbnail((720, 720))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    png = buf.getvalue()
    manual_covers_dir().mkdir(parents=True, exist_ok=True)
    (manual_covers_dir() / f"K{album_id}.png").write_bytes(png)
    (settings.covers_dir / f"{album_id}.png").write_bytes(png)
    with db.session() as conn:
        conn.execute("UPDATE albums SET has_cover=1, cover_source='manual', color=? WHERE id=?",
                     (_cover_color(png), album_id))
    return {"ok": True, "v": int(time.time())}


@router.delete("/api/albums/{album_id}/cover")
def delete_cover(album_id: str) -> dict:
    if not re.fullmatch(r"\d{4}", album_id):
        raise HTTPException(404)
    (manual_covers_dir() / f"K{album_id}.png").unlink(missing_ok=True)
    return {"ok": True, "note": "la copertina automatica torna al prossimo import"}
