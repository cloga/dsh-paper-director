#!/usr/bin/env python3
"""Fixed-argument JSON CLI. No shell, downloads, cloud APIs or DSH dependency."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
# The Host starts this fixed entry under Python -I. Add only this installed
# package directory, never the project/media directory or caller's PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from paper_director.safety import MediaError, output_directory, require


def progress(value, stage, message):
    print(json.dumps({"progress": max(0, min(1, value)), "stage": stage, "message": message}, ensure_ascii=False), flush=True)


def write_json(path, value):
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    path.write_text(encoded + "\n", encoding="utf-8")


def health(request):
    dependencies = {name: importlib.util.find_spec(module) is not None for name, module in
                    (("av", "av"), ("numpy", "numpy"), ("Pillow", "PIL"), ("faster-whisper", "faster_whisper"), ("vosk", "vosk"))}
    result = {"dependencies": dependencies, "codecs": {}, "fontReady": False, "cjkReady": False, "modelReady": False,
              "networkEnabled": False, "automaticModelDownload": False}
    if dependencies["av"]:
        import av
        for codec in ("libx264", "aac"):
            try:
                av.codec.Codec(codec, "w")
                result["codecs"][codec] = True
            except Exception:
                result["codecs"][codec] = False
    if dependencies["Pillow"]:
        from paper_director.fonts import choose_font
        for key, sample in (("fontReady", "Paper Director"), ("cjkReady", "纸上小导演时空旅行")):
            try:
                choose_font(request.get("fontPath"), [sample])
                result[key] = True
            except MediaError as error:
                result[key + "Error"] = error.code
    if request.get("modelPath"):
        from paper_director.alignment import model_directory
        try:
            model = model_directory(request["modelPath"])
            result["models"] = {
                "whisper": all((model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")),
                "vosk": (model / "am" / "final.mdl").is_file() and (model / "conf" / "mfcc.conf").is_file()}
            result["modelReady"] = any(result["models"].values())
            result["modelReadinessLevel"] = "files_present_not_inference_tested"
        except MediaError as error:
            result["modelError"] = error.code
    result["ready"] = all(dependencies[name] for name in ("av", "numpy", "Pillow")) and all(result["codecs"].get(name, False) for name in ("libx264", "aac")) and result["fontReady"]
    return result


def execute(request, output_dir):
    action = request.get("action")
    require(action in ("health", "probe", "align", "render", "frame"), "INVALID_REQUEST", "Unsupported worker action.")
    allowed = {
        "health": {"action", "outputDir", "fontPath", "modelPath"},
        "probe": {"action", "outputDir", "inputPath"},
        "align": {"action", "outputDir", "inputPath", "scenes", "characters", "engine", "modelPath", "segments"},
        "render": {"action", "outputDir", "timeline", "assets", "recordingAssetId", "fontPath", "preview"},
        "frame": {"action", "outputDir", "timeline", "assets", "time", "fontPath"}}
    require(not set(request) - allowed[action], "INVALID_REQUEST", "Unexpected request fields.")
    if action == "health":
        return health(request)
    missing = [name for name in ("av", "numpy", "PIL") if importlib.util.find_spec(name) is None]
    require(not missing, "DEPENDENCY_MISSING", "Install worker requirements before processing media.")
    if action == "probe":
        from paper_director.media import probe
        return probe(request.get("inputPath"))
    if action == "align":
        from paper_director.alignment import align
        result = align(request, progress)
        write_json(output_dir / "alignment.json", result)
        return {**result, "path": "alignment.json"}
    from paper_director.safety import assets_mapping
    from paper_director.renderer import render
    assets = assets_mapping(request.get("assets"))
    protected = {output_dir / name for name in ("movie.mp4", "frame.png", "result.json", "alignment.json")}
    require(not any(asset["path"] in protected for asset in assets.values()), "UNSAFE_PATH", "Outputs must not overwrite source assets.")
    return render(request, output_dir, assets, progress)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    output_dir = None
    try:
        path = Path(args.request)
        require(path.is_file() and path.stat().st_size <= 4 * 1024 * 1024, "INVALID_REQUEST", "Request file is missing or too large.")
        invalid_json = []
        def reject_constant(value):
            invalid_json.append("non-finite number")
            return None
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    invalid_json.append("duplicate key")
                result[key] = value
            return result
        request = json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=reject_constant, object_pairs_hook=pairs)
        require(isinstance(request, dict), "INVALID_REQUEST", "Request must be a JSON object.")
        output_dir = output_directory(request.get("outputDir"))
        protected = {output_dir / name for name in ("result.json", "result.tmp", "movie.mp4", "frame.png", "alignment.json")}
        input_paths = [path, request.get("inputPath"), request.get("fontPath")]
        if isinstance(request.get("assets"), dict):
            input_paths += [asset.get("path") for asset in request["assets"].values() if isinstance(asset, dict)]
        if any(isinstance(value, (str, Path)) and Path(value).resolve() in protected for value in input_paths):
            output_dir = None  # An error envelope must not overwrite an immutable input either.
            raise MediaError("UNSAFE_PATH", "Output files must not overlap source assets or the request.")
        require(not invalid_json, "INVALID_REQUEST", "Duplicate keys and non-finite numbers are forbidden.")
        os.environ["TMPDIR"] = str(output_dir)
        os.environ["TEMP"] = str(output_dir)
        os.environ["TMP"] = str(output_dir)
        os.environ["HF_HOME"] = str(output_dir / "model-cache")
        os.environ["XDG_CACHE_HOME"] = str(output_dir / "cache")
        # Enforce common offline library flags; adapters also require fully local models.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        progress(0, "starting", "Validating local media request.")
        result = execute(request, output_dir)
        envelope = {"ok": True, "result": result}
        status = 0
    except MediaError as error:
        envelope = {"ok": False, "error": {"code": error.code, "message": error.message}}
        status = 1
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        envelope = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "Invalid request or malformed media."}}
        status = 1
    except Exception:
        # Do not disclose paths, library stacks, media content, or host configuration.
        envelope = {"ok": False, "error": {"code": "MEDIA_PROCESSING_FAILED", "message": "Media decoding, rendering or local model execution failed."}}
        status = 1
    if output_dir is not None:
        try:
            write_json(output_dir / "result.tmp", envelope)
            (output_dir / "result.tmp").replace(output_dir / "result.json")
        except OSError:
            progress(1, "error", "Could not write outputDir/result.json.")
            return 1
    progress(1, "completed" if not status else "error", "Finished." if not status else envelope["error"]["code"])
    return status


if __name__ == "__main__":
    raise SystemExit(main())
