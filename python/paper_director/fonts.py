"""Administrator-selected fonts; discover installed CJK fonts without bundling them."""
import os
import struct
from pathlib import Path
from PIL import ImageFont
from .safety import MediaError, require, local_file


def font_candidates():
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    yield from (windows / name for name in ("msyh.ttc", "msjh.ttc", "simhei.ttf"))
    for root in (Path("/usr/share/fonts/opentype/noto"), Path("/usr/share/fonts/truetype/noto"), Path("/usr/local/share/fonts")):
        if root.is_dir():
            yield from root.glob("*Noto*CJK*.*")
            yield from root.glob("*Noto*Sans*SC*.*")
    yield Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def covered_codepoints(path, wanted):
    # TrueType/OpenType cmap only; no external tool, binary, font upload or font copying.
    data = path.read_bytes()
    def u16(offset):
        return struct.unpack_from(">H", data, offset)[0]
    def u32(offset):
        return struct.unpack_from(">I", data, offset)[0]
    base = u32(12) if data[:4] == b"ttcf" else 0
    cmap = None
    for i in range(u16(base + 4)):
        offset = base + 12 + i * 16
        if data[offset:offset + 4] == b"cmap":
            cmap = u32(offset + 8)
            break
    require(cmap is not None, "FONT_INVALID", "Font has no Unicode cmap.")
    covered = set()
    for i in range(u16(cmap + 2)):
        rec = cmap + 4 + i * 8
        platform, encoding = u16(rec), u16(rec + 2)
        if platform != 0 and not (platform == 3 and encoding in (1, 10)):
            continue
        sub = cmap + u32(rec + 4)
        fmt = u16(sub)
        if fmt == 12:
            groups = u32(sub + 12)
            require(groups <= 1000000, "FONT_INVALID", "Invalid font cmap size.")
            for j in range(groups):
                at = sub + 16 + j * 12
                first, last, glyph = u32(at), u32(at + 4), u32(at + 8)
                covered.update(c for c in wanted if first <= c <= last and glyph + c - first != 0)
        elif fmt == 4:
            count = u16(sub + 6) // 2
            ends, starts = sub + 14, sub + 16 + 2 * count
            deltas, ranges = starts + 2 * count, starts + 4 * count
            for j in range(count):
                first, last = u16(starts + 2 * j), u16(ends + 2 * j)
                delta, offset = u16(deltas + 2 * j), u16(ranges + 2 * j)
                for c in wanted:
                    if first <= c <= last:
                        glyph = u16(ranges + 2 * j + offset + 2 * (c - first)) if offset else c
                        if glyph and (glyph + delta) & 65535:
                            covered.add(c)
    return covered


def choose_font(configured=None, texts=()):
    wanted = {ord(c) for value in texts for c in value if not c.isspace()}
    candidates = [local_file(configured, 64 * 1024 * 1024)] if configured else font_candidates()
    had_font = False
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            candidate = local_file(str(candidate), 64 * 1024 * 1024)
            ImageFont.truetype(str(candidate), 24)
            had_font = True
            missing = wanted - covered_codepoints(candidate, wanted)
            if not missing:
                return candidate
            if configured:
                raise MediaError("FONT_GLYPHS_MISSING", "Configured font lacks required glyphs: " + ", ".join(f"U+{c:04X}" for c in sorted(missing)[:12]))
        except (OSError, ValueError, struct.error, IndexError):
            if configured:
                raise MediaError("FONT_INVALID", "Configured font is not a supported TrueType/OpenType font.") from None
    raise MediaError("FONT_GLYPHS_MISSING" if had_font else "FONT_NOT_READY", "Install a CJK font such as Noto Sans CJK or configure an existing fontPath.")
