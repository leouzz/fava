"""Optional password protection.

* ``FAVA_PASSWORD``        family password: required to use the app at all.
* ``FAVA_ADMIN_PASSWORD``  parents' password: required for management actions
  (import, cover review, uploads, profile management).

With neither set the app is open (and everyone is admin). Sessions are signed
cookies; media URLs can carry a signed key instead (``?k=``) because a
Chromecast fetching the audio cannot send the browser's cookie.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .config import settings

COOKIE = "fava_session"
SESSION_DAYS = 180

_secret: bytes | None = None
_lock = threading.Lock()
_failures: dict[str, list[float]] = {}


def secret() -> bytes:
    global _secret
    if _secret is None:
        env = os.environ.get("FAVA_SECRET")
        if env:
            _secret = env.encode()
        else:
            path = settings.data_dir / "secret.key"
            if not path.exists():
                settings.data_dir.mkdir(parents=True, exist_ok=True)
                path.write_text(secrets.token_hex(32))
                try:
                    path.chmod(0o600)
                except OSError:
                    pass
            _secret = path.read_text().strip().encode()
    return _secret


def _sign(msg: str) -> str:
    return hmac.new(secret(), msg.encode(), hashlib.sha256).hexdigest()[:40]


def enabled() -> bool:
    return bool(settings.password or settings.admin_password)


def make_token(role: str) -> str:
    exp = int(time.time()) + SESSION_DAYS * 86400
    body = f"{role}.{exp}"
    return f"{body}.{_sign(body)}"


def read_token(token: str | None) -> str | None:
    if not token or token.count(".") != 2:
        return None
    role, exp, sig = token.split(".")
    if role not in ("user", "admin") or not exp.isdigit() or int(exp) < time.time():
        return None
    return role if hmac.compare_digest(sig, _sign(f"{role}.{exp}")) else None


def media_key() -> str:
    return _sign("media")[:24]


def role_of(request: Request) -> str | None:
    """None = not logged in. Without passwords everyone is admin."""
    if not enabled():
        return "admin"
    role = read_token(request.cookies.get(COOKIE))
    if role:
        return role
    if not settings.password:  # only an admin password: browsing is open
        return "user"
    return None


def check_password(password: str) -> str | None:
    if settings.admin_password and hmac.compare_digest(password.encode(), settings.admin_password.encode()):
        return "admin"
    if settings.password and hmac.compare_digest(password.encode(), settings.password.encode()):
        return "user" if settings.admin_password else "admin"
    return None


def hash_pin(pin: str) -> str:
    """Stored form of a profile PIN: "<digits length or t>$<salt>$<pbkdf2>". The
    first field lets the Easy mode show a keypad that confirms on the last digit."""
    kind = str(len(pin)) if pin.isdigit() else "t"
    salt = secrets.token_hex(8)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), 100_000).hex()
    return f"{kind}${salt}${digest}"


def check_pin(stored: str | None, pin: str) -> bool:
    if not stored or stored.count("$") != 2:
        return False
    _kind, salt, digest = stored.split("$")
    got = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), 100_000).hex()
    return hmac.compare_digest(got, digest)


def pin_digits(stored: str | None) -> int | None:
    """Length of a numeric PIN (None when there is no PIN or it has other characters)."""
    kind = (stored or "").split("$")[0]
    return int(kind) if kind.isdigit() else None


def throttle(ip: str) -> None:
    """Slow down / lock out repeated wrong passwords (per client IP)."""
    now = time.time()
    with _lock:
        recent = [t for t in _failures.get(ip, []) if now - t < 600]
        _failures[ip] = recent
    if len(recent) >= 10:
        raise HTTPException(429, "Troppi tentativi: riprova tra qualche minuto")
    if len(recent) >= 3:
        time.sleep(min(5, len(recent) - 2))


def failed(ip: str) -> None:
    with _lock:
        _failures.setdefault(ip, []).append(time.time())


def reset(ip: str) -> None:
    with _lock:
        _failures.pop(ip, None)


# paths and the role they need (prefix match, method-aware)
PUBLIC = ("/api/auth/", "/api/config")
MEDIA = ("/api/stream/", "/api/covers/")
ADMIN_RULES = (
    ("POST", "/api/import"),
    ("POST", "/api/covers/candidates/"),
    ("PUT", "/api/uploads"),
    ("GET", "/api/uploads"),
    ("DELETE", "/api/uploads"),
    ("POST", "/api/albums/"),      # manual cover upload
    ("DELETE", "/api/albums/"),
    ("POST", "/api/profiles"),
    ("PUT", "/api/profiles/"),
    ("DELETE", "/api/profiles/"),
    ("PUT", "/api/nfc/"),
    ("DELETE", "/api/nfc/"),
)


async def middleware(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/") or path.startswith(PUBLIC):
        return await call_next(request)
    role = role_of(request)
    if role is None:
        key = request.query_params.get("k")
        if not (path.startswith(MEDIA) and request.method in ("GET", "HEAD") and key
                and hmac.compare_digest(key, media_key())):
            return JSONResponse({"detail": "login richiesto"}, status_code=401)
        role = "media"
    if role != "admin" and any(request.method == m and path.startswith(p) for m, p in ADMIN_RULES):
        return JSONResponse({"detail": "serve la password genitori"}, status_code=403)
    request.state.role = role
    return await call_next(request)
