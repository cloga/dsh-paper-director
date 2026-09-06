# Independent Paper Director media kernel

Python 3.11+; no DSH import, Node dependency, executable discovery, shell invocation,
cloud API, recording upload, model download, or bundled proprietary font.

## Install and run

```sh
python -m venv .venv
# Activate .venv using your operating system's normal command.
python -m pip install -r requirements.txt
python python/worker.py --request /absolute/path/to/job/request.json
python -m unittest discover -s tests/python -p 'test_worker.py' -v
python tests/python/synthetic_demo.py --output-dir tests/python/.artifacts/demo
```

Linux administrators should install **Noto Sans CJK** using their system package
manager, or supply an existing `fontPath`. Windows automatically discovers installed
Microsoft YaHei/JhengHei/SimHei fonts; nothing is copied or redistributed. An explicitly
configured TrueType/OpenType font is checked against every rendered code point via its
Unicode cmap; missing characters fail with `FONT_GLYPHS_MISSING`. Health also tests a CJK
sample. Tests containing Chinese deliberately fail when the environment lacks a suitable
font rather than approving boxes/tofu. Linux font discovery is implemented, but the
current development verification ran on Windows, not Linux.

## JSON contract

See `docs/contracts.md`. Every accepted job writes `outputDir/result.json`:

```json
{"ok":true,"result":{"path":"movie.mp4"}}
```

Errors are `{ "ok": false, "error": { "code": "...", "message": "..." } }` and exit 1.
Progress on stdout is newline-delimited JSON with `progress`, `stage`, `message`. Node
must use a fresh per-job output directory, check exit status **and** the result envelope,
and reject outputs from failed/cancelled/stale jobs. A malformed JSON file with no safely
usable outputDir, or a request whose result would overwrite an input, cannot receive a
result file; the worker exits 1 and emits a sanitized JSONL error instead. A partially
encoded movie may remain in outputDir on failure, but is never reported as success.

- `probe` returns bounded metadata directly; real signatures and full bounded decode,
  not file extensions or caller MIME, decide the type.
- `align` returns the full alignment directly plus `path: "alignment.json"`; the file
  contains the alignment itself.
- `render` returns `path: "movie.mp4"`, dimensions, fps, duration, frame count, codecs,
  color-space/range and warnings. `preview` keeps the same geometry/timing and drawing,
  using a higher H.264 CRF; the optional smaller-preview capability is not used.
- `frame` returns `path: "frame.png"`, dimensions and requested time, and invokes the
  exact same `Painter.draw` as movie encoding.
- `health` reports dependencies, encoder availability, font/CJK readiness, offline
  flags, and optionally local-model file readiness. `modelReady` means required files
  exist, **not** that inference succeeded or the model is suitable for a language.

Only worker-owned relative output names are returned. Font/input/model paths are never
returned. Unexpected top-level fields, URLs, device/alternate-stream paths, invalid asset
IDs, non-finite numbers, duplicate JSON keys, invalid timestamps, overlapping cues/audio
pieces, unknown characters and unmapped assets are rejected.

## Alignment semantics

`engine: "segments"` requires an explicit list:

```json
[{"start":0.2,"end":1.4,"text":"Provided transcript text","dialogueId":"optional-existing-id"}]
```

Ordered fuzzy matching may join adjacent word segments. `recognizedText` always consists
of supplied/model-output words; `authorText` always comes from dialogue. Characters come
only from dialogue labels; no voiceprint identification, speaker inference, or synthetic
ASR is implemented. Missing dialogue has null start/end and `matchStatus: "unmatched"`.
Low-confidence candidates have actual segment times and `needs_review`. Unconsumed
transcript entries remain `unmatchedSpeech`. Unannotated portions of provided transcripts
are **not verified silence**. Node owns confirmation, pause protection and whether a
needs-review timeline may be exported. Matching has a bounded forward search; long or
heavily reordered transcripts may need explicit labels/manual correction.

For real local ASR, optionally install `requirements-asr.txt`, then supply:

- `engine: "whisper"`, `modelPath`: a preinstalled faster-whisper/CTranslate2 directory
  with `model.bin`, `config.json`, **and `tokenizer.json`**. CPU int8 is used and
  `local_files_only=True`; the tokenizer requirement prevents fallback downloads.
- `engine: "vosk"`, `modelPath`: an existing Vosk directory with `am/final.mdl` and
  `conf/mfcc.conf` plus that model's normal remaining files. Word timestamps are enabled.

Models must be provisioned by an administrator. No model names, remote repository IDs,
automatic downloads or cloud fallback are accepted. Neither adapter was quality-tested
with real speech in this delivery: no weights or public recorded-speech fixture were
provided. Missing-model rejection is tested; generated tones are **not** ASR evidence.

## Rendering and authoritative timeline

The Node compiler owns ripple mapping, approved cuts, dialogue/subtitle placement and
inserted transition durations. Python uses absolute compiled `start/end` values without
re-estimating timing. `audioSegments` copy recording sample slices onto their target
starts; `audioOverlays` sum at `start` with `10 ** (gainDb / 20)` gain and are trimmed at
movie end. Sample clipping produces a warning. Original recording files remain unchanged.
Intro/outro and transitions are silent unless the compiled timeline places audio there.

All ordinary scenes use hard cuts. Pillow draws deterministic paper texture/framing,
active script-character name badges, normal comic captions, thought bubbles with small
bubble tails, small dialogue, burst dialogue, magic expanding light rings, time-label
cards, title and credits. Multiple dialogue bubbles are supported (maximum three); text
that cannot fit safely fails with `TEXT_OVERFLOW` rather than being silently truncated.
The first four character badges are displayed, and `both` highlights the first two
characters in authoritative character order. Nodes should keep this MVP cast small.

PyAV encodes H.264/yuv420p + AAC/stereo, converts full-range RGB into limited-range BT.709,
and tags range/primaries/transfer/matrix consistently. The image cache is bounded to four
resized images. Output uses exactly the timeline fps and `ceil(duration * fps)` frames;
there can be one frame of video duration rounding and AAC codec padding. Frame requests
at duration render the last instant, not an out-of-range scene.

## Boundaries and limits

The worker is a restricted brokered CLI, **not an OS filesystem sandbox**. Node must own
request files, fixed asset mapping, `fontPath`, `modelPath` and `outputDir`, run under an
appropriate process identity and enforce job concurrency/timeout/cancellation. Do not
expose this raw CLI request directly to children or remote clients. Worker outputs,
Python temp variables and library cache variables are confined to outputDir; bytecode
writing is disabled by the worker. Installed Python/module/font/model reads remain
necessary. No media is downloaded.

Current safety ceilings: 4 MiB request JSON, 512 MiB individual asset, 30 minutes media,
8192 maximum source side and 16,777,216 source pixels, one audio/one video stream, at most
8 input channels/192 kHz, output 3840x2160/60fps and 150 billion pixel-frames. Animated
images, SVG/HTML, playlists and unsupported demuxers are rejected. Audio is currently
mixed in memory; long projects may use multiple GB including decoded source and output.
Use host resource limits and conservative concurrent-job counts. FFmpeg demuxing uses
signature-selected formats, a file-only protocol whitelist and disabled external MOV
references; malformed native-code media still warrants patched dependencies and OS
isolation for adversarial deployments.

## Synthetic evidence and licensing

`tests/python/synthetic_demo.py` creates two anonymous geometric puppet pictures,
oscillator tones, explicit provided transcript data, a 5.5-second Chinese-captioned
movie and PNG. Those generated fixtures are dedicated to **CC0-1.0**; no source family
photos, real voices, proprietary movie assets or font copies are included. Outputs and
isolated test dependencies are gitignored. A fresh run creates:

- `.artifacts/demo/render/movie.mp4` — H.264/AAC, 640x480, 12fps, 66 frames;
- `.artifacts/demo/frame/frame.png` — shared drawing, thought bubble/name highlight;
- `.artifacts/demo/align/alignment.json` — provided transcript and unmatched examples;
- `.artifacts/demo/evidence.json` — decoded codec/range/frame-count/duration and SHA-256.

The unit suite checks actual encode/decode, exact raw audio splice/overlay samples,
frame/Painter pixel equality, lossy movie-frame error, BT.709 tags, safety failures,
font readiness, author/transcript separation and missing local-model handling. Technical
decode/format checks are not a claim that a human listened to audio or validated ASR.
