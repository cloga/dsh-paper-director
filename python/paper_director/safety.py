"""Bounded JSON and local-file boundary. This worker is not a filesystem sandbox.

Only the trusted Node broker may construct requests: it owns asset paths and outputDir.
No project fields become paths, commands, network addresses, or executable code.
"""
from pathlib import Path
import math
import re

MAX_DURATION = 1800.0
MAX_BYTES = 512 * 1024 * 1024
MAX_PIXELS = 16_777_216
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class MediaError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise MediaError(code, message)


def number(value, name, minimum=0, maximum=MAX_DURATION):
    require(isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and minimum <= value <= maximum,
            "INVALID_REQUEST", f"Invalid {name}.")
    return float(value)


def integer(value, name, minimum, maximum):
    number(value, name, minimum, maximum)
    require(int(value) == value, "INVALID_REQUEST", f"Invalid {name}.")
    return int(value)


def text(value, name="text", maximum=10000):
    require(isinstance(value, str) and len(value) <= maximum,
            "INVALID_REQUEST", f"Invalid {name}.")
    return value


def identifier(value):
    require(isinstance(value, str) and ID.fullmatch(value), "INVALID_REQUEST", "Invalid asset or dialogue id.")
    return value


def local_file(value, limit=MAX_BYTES):
    text(value, "local path", 4096)
    require(value and not value.startswith(("\\\\", "//")) and "://" not in value
            and not value.lower().startswith(("file:", "pipe:", "data:", "concat:")),
            "UNSAFE_PATH", "Only broker-owned local files are accepted.")
    path = Path(value)
    # Forbid NT alternate streams while allowing a drive letter.
    require(":" not in str(path)[2:], "UNSAFE_PATH", "Alternate streams are not accepted.")
    require(path.is_file() and not path.is_symlink(), "INVALID_ASSET", "Local asset is missing or not a regular file.")
    require(path.stat().st_size <= limit, "LIMIT_EXCEEDED", "Asset exceeds the byte limit.")
    return path.resolve()


def output_directory(value):
    text(value, "outputDir", 4096)
    require(value and "://" not in value and not value.startswith(("\\\\", "//")), "UNSAFE_PATH", "Invalid output directory.")
    path = Path(value)
    require(":" not in str(path)[2:], "UNSAFE_PATH", "Alternate streams are not accepted.")
    require(not path.is_symlink(), "UNSAFE_PATH", "Output directory cannot be a symlink.")
    path.mkdir(parents=True, exist_ok=True)
    path = path.resolve()
    for name in ("result.json", "result.tmp", "movie.mp4", "frame.png", "alignment.json"):
        target = path / name
        require(not target.is_symlink(), "UNSAFE_PATH", "Output target cannot be a symlink.")
        require(not target.exists() or (target.is_file() and target.stat().st_nlink == 1),
                "UNSAFE_PATH", "Output target must not be a directory or shared hard link.")
    return path


def assets_mapping(value):
    require(isinstance(value, dict) and len(value) <= 512, "INVALID_REQUEST", "Invalid asset mapping.")
    assets = {}
    for key, asset in value.items():
        identifier(key)
        require(isinstance(asset, dict) and asset.get("kind") in ("image", "audio", "video"), "INVALID_REQUEST", "Invalid mapped asset.")
        assets[key] = {"path": local_file(asset.get("path")), "kind": asset["kind"]}
    return assets
