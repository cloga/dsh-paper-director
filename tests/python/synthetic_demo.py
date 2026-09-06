"""CC0 synthetic fixtures: geometric paper puppets + oscillator tones, NOT ASR speech.

Run: python tests/python/synthetic_demo.py --output-dir tests/python/.artifacts/demo
The transcript is explicitly provided author/test data; tones contain no speech.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import wave
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))


def fixtures(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    assets = {}
    for index, color in enumerate(("#4389c2", "#b37bd0")):
        image = Image.new("RGB", (640, 440), "#f0dfb0")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 300, 640, 440), fill="#7eaf74")
        draw.ellipse((440, 25, 545, 130), fill="#f8cc57")
        draw.polygon([(100, 340), (180, 140), (260, 340)], fill=color, outline="#293449", width=5)
        draw.ellipse((143, 85, 217, 159), fill="#fff1d4", outline="#293449", width=4)
        draw.ellipse((160, 112, 165, 117), fill="#293449")
        draw.ellipse((192, 112, 197, 117), fill="#293449")
        draw.rectangle((390, 195, 470, 300), fill="#b56d47", outline="#293449", width=4)
        draw.ellipse((404, 214, 456, 266), fill="#fff1d4", outline="#293449", width=3)
        draw.line((430, 240, 430 + index * 15, 221), fill="#293449", width=3)
        name = f"anonymous-{index}.png"
        image.save(output / name)
        assets[f"image{index}"] = {"path": str(output / name), "kind": "image", "mime": "image/png", "metadata": {}}
    for key, seconds, frequency, gain in (("recording", 3, 330, .12), ("chime", .4, 880, .08)):
        rate = 48000
        t = np.arange(round(seconds * rate)) / rate
        signal = np.sin(math_tau() * frequency * t) * gain
        signal *= np.minimum(1, t * 30) * np.minimum(1, (seconds - t) * 30)
        with wave.open(str(output / (key + ".wav")), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes((signal * 32767).astype("<i2").tobytes())
        assets[key] = {"path": str(output / (key + ".wav")), "kind": "audio", "mime": "audio/wav", "metadata": {}}
    characters = [{"id": "paper", "name": "纸偶", "color": "#4389c2"}, {"id": "clock", "name": "时钟", "color": "#b37bd0"}]
    timeline = {"width": 640, "height": 480, "fps": 12, "duration": 5.5, "sampleRate": 48000,
                "title": "纸偶的时空旅行", "credits": {"director": "匿名合成演示", "voice": "合成音调（无语音）"},
                "characters": characters, "introSeconds": .5, "outroSeconds": .5,
                "cues": [{"id": "c0", "sceneId": "s0", "imageAssetId": "image0", "start": .5, "end": 2, "kind": "scene"},
                         {"id": "cm", "sceneId": "s1", "imageAssetId": "image1", "start": 2, "end": 2.5, "kind": "magic"},
                         {"id": "c1", "sceneId": "s1", "imageAssetId": "image1", "start": 2.5, "end": 4, "kind": "scene"},
                         {"id": "ct", "sceneId": "s1", "start": 4, "end": 5, "kind": "time", "timeLabel": "一百年以后"}],
                "subtitles": [{"id": "d0", "dialogueId": "d0", "sceneId": "s0", "characterId": "paper", "text": "时间之门在哪里？", "mode": "normal", "start": .5, "end": 1.2},
                              {"id": "d1", "dialogueId": "d1", "sceneId": "s0", "characterId": "clock", "text": "让我想一想。", "mode": "thought", "start": 1.2, "end": 2},
                              {"id": "d2", "dialogueId": "d2", "sceneId": "s1", "characterId": "both", "text": "出发！", "mode": "burst", "start": 2.5, "end": 3.2},
                              {"id": "d3", "dialogueId": "d3", "sceneId": "s1", "characterId": "paper", "text": "轻轻地走。", "mode": "small", "start": 3.2, "end": 4}],
                "audioSegments": [{"sourceStart": 0, "sourceEnd": 1.5, "start": .5}, {"sourceStart": 1.5, "sourceEnd": 3, "start": 2.5}],
                "audioOverlays": [{"assetId": "chime", "start": 2, "gainDb": -3}, {"assetId": "chime", "start": 4, "gainDb": -6}],
                "warnings": ["Synthetic tones are not speech; captions are provided author text, not ASR."]}
    scenes = [{"id": "s0", "dialogue": [{"id": "d0", "characterId": "paper", "text": "时间之门在哪里？"}, {"id": "missing", "characterId": "clock", "text": "这句没有标注"}]}]
    return {"assets": assets, "timeline": timeline, "scenes": scenes, "characters": characters}


def math_tau():
    return 2 * np.pi


def call_worker(request, folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    request = {**request, "outputDir": str(folder.resolve())}
    request_file = folder / "request.json"
    request_file.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    completed = subprocess.run([sys.executable, str(ROOT / "python" / "worker.py"), "--request", str(request_file)],
                               check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
    return completed, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    data = fixtures(output)
    evidence = {"license": "CC0-1.0", "mediaOrigin": "Generated anonymous geometric images and oscillator tones; no private media.",
                "speechClaim": "None. Provided transcript fixture only; not an ASR quality test."}
    jobs = {
        "probe": {"action": "probe", "inputPath": data["assets"]["recording"]["path"]},
        "align": {"action": "align", "inputPath": data["assets"]["recording"]["path"], "engine": "segments",
                  "scenes": data["scenes"], "characters": data["characters"],
                  "segments": [{"start": 0, "end": .7, "text": "时间之门在哪里？"}, {"start": 1, "end": 1.4, "text": "未匹配的额外话语"}]},
        "render": {"action": "render", "timeline": data["timeline"], "assets": data["assets"], "recordingAssetId": "recording"},
        "frame": {"action": "frame", "timeline": data["timeline"], "assets": data["assets"], "time": 1.5}}
    for name, request in jobs.items():
        completed, result = call_worker(request, output / name)
        if not result["ok"]:
            raise RuntimeError(f"{name}: {result}")
        evidence[name] = result["result"]
        (output / name / "progress.jsonl").write_text(completed.stdout, encoding="utf-8")
    import av
    with av.open(str(output / "render" / "movie.mp4")) as movie:
        stream = movie.streams.video[0]
        evidence["decodedMovie"] = {"videoCodec": stream.codec_context.name, "audioCodec": movie.streams.audio[0].codec_context.name,
                                    "colorRange": stream.codec_context.color_range, "colorSpace": stream.codec_context.colorspace,
                                    "frames": sum(1 for _ in movie.decode(video=0)), "duration": movie.duration / av.time_base}
    evidence["movieSha256"] = hashlib.sha256((output / "render" / "movie.mp4").read_bytes()).hexdigest()
    (output / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
