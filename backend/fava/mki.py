"""MKI (Faba box) audio container.

An ``.MKI`` file is a regular MP3 whose bytes are scrambled with a fixed
substitution that depends only on the byte position modulo 4. The mapping is
a bijection, so decoding is a table lookup and can start at any offset —
which lets us stream (and seek inside) MKI files without ever writing a
decrypted copy to disk.

The nibble tables reproduce the mapping documented by the myfaba-hacks
project (https://github.com/wansors/myfaba-hacks).
"""

from __future__ import annotations

import io
import os
from typing import BinaryIO, Iterator

_HIGH = (
    (0x3, 0x2, 0x1, 0x0, 0x7, 0x6, 0x5, 0x4, 0xB, 0xA, 0x9, 0x8, 0xF, 0xE, 0xD, 0xC),
    (0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF),
    (0x1, 0x0, 0x3, 0x2, 0x5, 0x4, 0x7, 0x6, 0x9, 0x8, 0xB, 0xA, 0xD, 0xC, 0xF, 0xE),
    (0x2, 0x3, 0x0, 0x1, 0x6, 0x7, 0x4, 0x5, 0xA, 0xB, 0x8, 0x9, 0xE, 0xF, 0xC, 0xD),
)
_LOW_EVEN = (
    (0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7),
    (0x5, 0x4, 0x7, 0x6, 0x1, 0x0, 0x3, 0x2),
    (0x9, 0x8, 0xB, 0xA, 0xD, 0xC, 0xF, 0xE),
    (0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7),
)
_LOW_ODD = (
    (0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF),
    (0xD, 0xC, 0xF, 0xE, 0x9, 0x8, 0xB, 0xA),
    (0x1, 0x0, 0x3, 0x2, 0x5, 0x4, 0x7, 0x6),
    (0x8, 0x9, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF),
)


def _decode_byte(phase: int, value: int) -> int:
    hi = _HIGH[phase].index(value >> 4) * 2
    lo = value & 0x0F
    if lo in _LOW_EVEN[phase]:
        idx = _LOW_EVEN[phase].index(lo)
    else:
        idx = _LOW_ODD[phase].index(lo)
        hi += 1
    return idx * 32 + hi


DECODE: tuple[bytes, ...] = tuple(bytes(_decode_byte(p, v) for v in range(256)) for p in range(4))
ENCODE: tuple[bytes, ...] = tuple(
    bytes(DECODE[p].index(v) for v in range(256)) for p in range(4)
)
for _p in range(4):  # sanity: every table must be a permutation
    assert sorted(DECODE[_p]) == list(range(256))


def decode(data: bytes, offset: int = 0) -> bytes:
    """Decode ``data`` that starts at absolute file position ``offset``."""
    out = bytearray(len(data))
    for i in range(4):
        phase = (offset + i) % 4
        out[i::4] = data[i::4].translate(DECODE[phase])
    return bytes(out)


def encode(data: bytes, offset: int = 0) -> bytes:
    out = bytearray(len(data))
    for i in range(4):
        phase = (offset + i) % 4
        out[i::4] = data[i::4].translate(ENCODE[phase])
    return bytes(out)


def iter_decoded(path: str | os.PathLike, start: int = 0, end: int | None = None,
                 chunk: int = 256 * 1024) -> Iterator[bytes]:
    """Yield decoded bytes of ``path`` in the inclusive range [start, end]."""
    size = os.path.getsize(path)
    if end is None or end >= size:
        end = size - 1
    with open(path, "rb") as fh:
        fh.seek(start)
        pos = start
        while pos <= end:
            buf = fh.read(min(chunk, end - pos + 1))
            if not buf:
                break
            yield decode(buf, pos)
            pos += len(buf)


class DecodingReader(io.RawIOBase):
    """Seekable file-like object returning decoded MKI bytes (for mutagen)."""

    def __init__(self, path: str | os.PathLike):
        self._fh: BinaryIO = open(path, "rb")

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        return self._fh.seek(offset, whence)

    def tell(self) -> int:
        return self._fh.tell()

    def readinto(self, b) -> int:  # type: ignore[override]
        pos = self._fh.tell()
        data = self._fh.read(len(b))
        n = len(data)
        b[:n] = decode(data, pos)
        return n

    def close(self) -> None:
        self._fh.close()
        super().close()
