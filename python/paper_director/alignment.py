"""Real local ASR or explicitly supplied transcript; never infer a voice identity."""
import contextlib
import difflib
import json
import re
import sys
from pathlib import Path
import numpy as np
from .media import decode_audio, probe
from .safety import MediaError, require, number, text, identifier


def normalize(value):
    return re.sub(r"[^\w]", "", value, flags=re.UNICODE).casefold()


def model_directory(value):
    text(value, "modelPath", 4096)
    require(value and "://" not in value and not value.startswith(("\\\\", "//")), "MODEL_NOT_READY", "A preinstalled local modelPath is required; downloads are disabled.")
    path = Path(value)
    require(path.is_dir() and not path.is_symlink(), "MODEL_NOT_READY", "A preinstalled local model directory is required.")
    return path.resolve()


def transcribe(request, duration, progress):
    engine = request.get("engine", "segments")
    require(engine in ("segments", "whisper", "vosk"), "INVALID_REQUEST", "Unsupported alignment engine.")
    if engine == "segments":
        return request.get("segments"), "provided_segments"
    path = model_directory(request.get("modelPath"))
    # Decode from a fixed local asset with our restricted demuxer, not an ASR URL/file loader.
    audio = decode_audio(request["inputPath"], 16000).mean(axis=0)
    progress(.2, "align", "Running preinstalled local speech model; no network or voice identification.")
    if engine == "whisper":
        require((path / "model.bin").is_file() and (path / "config.json").is_file()
                and (path / "tokenizer.json").is_file(), "MODEL_NOT_READY", "Local Whisper model requires model.bin, config.json and tokenizer.json.")
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise MediaError("DEPENDENCY_MISSING", "Install the optional faster-whisper dependency.") from None
        # tokenizer.json is mandatory, preventing fallback tokenizer downloads as well.
        with contextlib.redirect_stdout(sys.stderr):
            model = WhisperModel(str(path), device="cpu", compute_type="int8", local_files_only=True)
            segments, _ = model.transcribe(audio, beam_size=5, word_timestamps=True, vad_filter=False)
            result = []
            for segment in segments:
                if segment.words:
                    result.extend({"start": word.start, "end": word.end, "text": word.word} for word in segment.words)
                else:
                    result.append({"start": segment.start, "end": segment.end, "text": segment.text})
        return result, "local_whisper"
    require((path / "am" / "final.mdl").is_file() and (path / "conf" / "mfcc.conf").is_file(),
            "MODEL_NOT_READY", "Local Vosk model files are missing.")
    try:
        import vosk
    except ImportError:
        raise MediaError("DEPENDENCY_MISSING", "Install the optional vosk dependency.") from None
    result = []
    with contextlib.redirect_stdout(sys.stderr):
        vosk.SetLogLevel(-1)
        model = vosk.Model(str(path))
        recognizer = vosk.KaldiRecognizer(model, 16000)
        recognizer.SetWords(True)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        for offset in range(0, len(pcm), 8000):
            if recognizer.AcceptWaveform(pcm[offset:offset + 8000]):
                result.extend(json.loads(recognizer.Result()).get("result", []))
        result.extend(json.loads(recognizer.FinalResult()).get("result", []))
    return [{"start": word["start"], "end": word["end"], "text": word["word"]} for word in result], "local_vosk"


def align(request, progress):
    metadata = probe(request.get("inputPath"))
    require(metadata.get("audioStreams") == 1, "INVALID_MEDIA", "Alignment needs one audio stream.")
    duration = metadata["duration"]
    scenes = request.get("scenes")
    require(isinstance(scenes, list) and len(scenes) <= 256, "INVALID_REQUEST", "Invalid scenes.")
    dialogues = []
    ids = set()
    characters = request.get("characters", [])
    require(isinstance(characters, list) and len(characters) <= 64, "INVALID_REQUEST", "Invalid characters.")
    allowed_characters = {identifier(c.get("id")) for c in characters if isinstance(c, dict)} | {"both", "narrator"}
    for scene in scenes:
        require(isinstance(scene, dict), "INVALID_REQUEST", "Invalid scene.")
        scene_id = identifier(scene.get("id"))
        lines = scene.get("dialogue", [])
        require(isinstance(lines, list) and len(lines) <= 256, "INVALID_REQUEST", "Invalid dialogue.")
        for dialogue in lines:
            require(isinstance(dialogue, dict), "INVALID_REQUEST", "Invalid dialogue.")
            key = identifier(dialogue.get("id"))
            require(key not in ids and dialogue.get("characterId") in allowed_characters, "INVALID_REQUEST", "Invalid dialogue identity.")
            ids.add(key)
            author = text(dialogue.get("text"), "author text", 4000)
            dialogues.append({"id": key, "dialogueId": key, "sceneId": scene_id,
                              "characterId": dialogue["characterId"], "authorText": author,
                              "start": None, "end": None, "recognizedText": "", "matchStatus": "unmatched"})
    require(len(dialogues) <= 2048, "LIMIT_EXCEEDED", "Too many dialogue lines.")
    segments, method = transcribe(request, duration, progress)
    require(isinstance(segments, list) and len(segments) <= 20000, "INVALID_REQUEST", "segments must be an explicit timestamped transcript list.")
    clean = []
    previous = 0
    for segment in segments:
        require(isinstance(segment, dict), "INVALID_REQUEST", "Invalid transcript segment.")
        start = number(segment.get("start"), "segment start", 0, duration)
        end = number(segment.get("end"), "segment end", 0, duration)
        require(start < end and start >= previous - .02, "INVALID_REQUEST", "Transcript segments must be chronological and non-overlapping.")
        previous = end
        value = text(segment.get("text"), "recognized text", 4000)
        require(value.strip(), "INVALID_REQUEST", "Transcript segment text cannot be empty.")
        bound = segment.get("dialogueId")
        require(bound is None or bound in ids, "INVALID_REQUEST", "Unknown imported dialogueId.")
        clean.append({"start": start, "end": end, "text": value, "dialogueId": bound})
    used = set()
    cursor = 0
    # Ordered fuzzy matching joins adjacent ASR words, but never manufactures timestamps or text.
    for dialogue in dialogues:
        target = normalize(dialogue["authorText"])
        if not target:
            continue
        best = None
        for left in range(cursor, min(len(clean), cursor + 200)):
            if left in used:
                continue
            joined = ""
            for right in range(left, min(len(clean), left + 80)):
                segment = clean[right]
                if right in used or segment["dialogueId"] not in (None, dialogue["dialogueId"]):
                    break
                joined += segment["text"]
                score = difflib.SequenceMatcher(None, target, normalize(joined), autojunk=False).ratio()
                explicit = all(item["dialogueId"] == dialogue["dialogueId"] for item in clean[left:right + 1])
                rank = score + (.3 if explicit else 0)
                if best is None or rank > best[0]:
                    best = (rank, score, left, right, joined, explicit)
                if len(normalize(joined)) > len(target) * 2 + 20:
                    break
        if best and (best[1] >= .55 or best[5]):
            _, score, left, right, joined, explicit = best
            dialogue.update(start=clean[left]["start"], end=clean[right]["end"], recognizedText=joined,
                            matchStatus="matched" if score >= .85 else "needs_review", confidence=round(score, 4))
            used.update(range(left, right + 1))
            cursor = right + 1
    unmatched = [{"start": item["start"], "end": item["end"], "text": item["text"]}
                 for i, item in enumerate(clean) if i not in used]
    result = {"duration": duration, "utterances": dialogues,
              "speechRanges": [{"start": item["start"], "end": item["end"]} for item in clean],
              "unmatchedSpeech": unmatched, "method": method,
              "warnings": ["Provided transcript coverage is user-supplied; unannotated audio is not verified silence."] if method == "provided_segments" else
                          ["Local ASR may miss or misrecognize speech; review against the recording."]}
    return result
