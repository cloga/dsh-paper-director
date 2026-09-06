# Media-kernel verification checkpoint

Verified locally on Windows with Python 3.13.15, PyAV 18.1.0, NumPy 2.5.2,
Pillow 12.3.0 and an already installed CJK system font. No private media or
cloud services were used. No repository commit/push was performed by the media worker implementer.

## Commands

After installing `requirements.txt` in an isolated Python environment:

```sh
python -m unittest discover -s tests/python -p test_worker.py -v
python tests/python/synthetic_demo.py --output-dir tests/python/.artifacts/demo
```

Result: **16 tests passed** (18.407 seconds in the final recorded run), then the
synthetic CLI demo completed probe, provided-segments alignment, full rendering and
shared frame export successfully.

## Evidence

The generator creates only CC0 anonymous geometric puppet images and oscillator tones.
It explicitly labels the imported transcript as provided data, not recognized speech.

- `tests/python/.artifacts/demo/render/movie.mp4`: 640×480, 12 fps, 66 decoded frames,
  5.5 seconds; actual H.264 video and AAC audio.
- Video stream range, colorspace, primaries and transfer tags are all `1`
  (limited-range/BT.709).
- Movie SHA-256 in this verified environment:
  `3c88da21d788bed07b9608cb4aaeaac3c8b7e81fd5023360395c522a0736654a`.
  Different fonts/library builds may produce a different valid movie hash.
- `tests/python/.artifacts/demo/frame/frame.png`: inspected 640×480 PNG with a
  highlighted clock name badge, Chinese thought caption, little thought bubbles and
  paper framing; the test asserts exact pixel equality with the shared Painter.
- Raw timeline audio splice, approved source-cut and overlay-gain/summation samples
  pass exact/allclose assertions; movie audio also decodes successfully.
- The selected decoded H.264 frame matches the shared Painter with mean absolute
  RGB error below 8 (allowing lossy compression).
- Alignment retains an unmatched dialogue with null timestamps and a separate
  unmatched-speech entry; author text and supplied transcript remain separate.
- Safety tests cover URL/playlist/SVG/corruption rejection, invalid timing and bounds,
  unmapped asset references, unexpected command fields, duplicate/non-finite JSON,
  output/input collision protection and missing fonts/glyphs/models.

Artifacts and isolated dependency installs are gitignored and can be regenerated.
This is technical format/contract evidence, **not** a listening test or ASR accuracy
claim. Real Whisper/Vosk inference still needs administrator-provided local weights
and a consented/public spoken-audio validation fixture. Linux discovery code exists,
but Linux runtime verification remains outstanding. See `python/README.md` for limits.
