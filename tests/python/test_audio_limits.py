"""P1 media resource regressions; generated tones/PNGs only, no model or network."""
from fractions import Fraction
from pathlib import Path
import copy
import sys
import unittest
from unittest.mock import patch
import wave

import av
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from paper_director import media, renderer
from paper_director.safety import MediaError

RATE = 48000


def tone(path, seconds, amplitude=.25):
    time = np.arange(round(seconds * RATE)) / RATE
    # A non-zero phase deliberately exposes clicks at artificial truncation boundaries.
    samples = (np.sin(2 * np.pi * 337 * time + .7) * amplitude * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(samples.tobytes())
    return path


def timeline(duration=3):
    return {"width": 320, "height": 240, "fps": 12, "duration": duration, "sampleRate": RATE,
            "introSeconds": 0, "outroSeconds": 0, "title": "Synthetic", "credits": {}, "characters": [],
            "cues": [], "subtitles": [], "audioSegments": [], "audioOverlays": [], "warnings": []}


class AudioResourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output = ROOT / "tests" / "python" / ".artifacts" / "audio-limits"
        cls.output.mkdir(parents=True, exist_ok=True)
        cls.long_sound = tone(cls.output / "long-tone.wav", 20)
        cls.short_sound = tone(cls.output / "short-tone.wav", 1)
        cls.image = cls.output / "anonymous-paper.png"
        Image.new("RGB", (1200, 900), "#d5ad73").save(cls.image)
        cls.aac = cls.output / "anonymous-aac.m4a"
        with av.open(str(cls.aac), "w", format="mp4") as container:
            stream = container.add_stream("aac", rate=RATE)
            stream.layout = "stereo"
            samples = np.sin(2 * np.pi * 337 * np.arange(RATE) / RATE).astype(np.float32) * .2
            for start in range(0, RATE, 1024):
                chunk = np.stack((samples[start:start + 1024], samples[start:start + 1024]))
                frame = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="stereo")
                frame.sample_rate, frame.time_base, frame.pts = RATE, Fraction(1, RATE), start
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode(None):
                container.mux(packet)

    def assets(self):
        return {"effect": {"path": self.long_sound, "kind": "audio"},
                "recording": {"path": self.short_sound, "kind": "audio"}}

    def test_prefix_decoder_never_probes_full_asset_and_bounds_retained_samples(self):
        info = {}
        with patch.object(media, "probe", side_effect=AssertionError("Prefix must not scan full media")):
            samples = media.decode_audio(self.long_sound, max_duration=.125, info=info)
        self.assertEqual(samples.shape, (2, 6000))
        self.assertTrue(info["truncated"])
        self.assertLess(info["decodedFrames"], 10)
        self.assertLessEqual(samples.nbytes, 2 * 6000 * 4)

    def test_long_effect_is_limited_faded_and_does_not_cover_later_audio(self):
        value = timeline(2)
        value["audioSegments"] = [{"sourceStart": 0, "sourceEnd": 1, "start": 1}]
        value["audioOverlays"] = [{"assetId": "effect", "start": .2, "gainDb": 0, "maxDuration": .3}]
        output, warnings = media.mix_audio(value, self.assets(), "recording")
        self.assertGreater(np.abs(output[:, 10000:15000]).max(), .01)
        self.assertTrue(np.all(output[:, 24000:48000] == 0), "Effect cannot spill beyond its compiled window")
        self.assertTrue(np.all(output[:, 23999] == 0), "Truncated effect ends at zero after its fade")
        np.testing.assert_array_equal(output[:, 48000:96000], media.decode_audio(self.short_sound))
        self.assertTrue(any("10 ms tail fade" in message for message in warnings))

    def test_repeated_sound_prefix_is_decoded_once_at_largest_needed_duration(self):
        value = timeline(4)
        value["audioOverlays"] = [{"assetId": "effect", "start": index * .5, "gainDb": -3,
                                    "maxDuration": .1 if index % 2 else .2} for index in range(6)]
        real_decode = media.decode_audio
        with patch.object(media, "decode_audio", wraps=real_decode) as decoder:
            media.mix_audio(value, self.assets(), None)
        self.assertEqual(decoder.call_count, 1)
        self.assertAlmostEqual(decoder.call_args.kwargs["max_duration"], .2)

    def test_default_effect_cap_is_ten_seconds(self):
        value = timeline(12)
        value["audioOverlays"] = [{"assetId": "effect", "start": 0, "gainDb": 0}]
        output, warnings = media.mix_audio(value, self.assets(), None)
        self.assertTrue(np.all(output[:, 10 * RATE:] == 0))
        self.assertTrue(warnings)

    def test_invalid_overlay_limits_are_rejected_by_validation_and_mixer(self):
        for bad in (0, -.1, float("nan"), float("inf"), True, "3", 601):
            value = timeline()
            value["audioOverlays"] = [{"assetId": "effect", "start": 0, "gainDb": 0, "maxDuration": bad}]
            with self.subTest(limit=bad):
                with self.assertRaises(MediaError):
                    renderer.validate_timeline(copy.deepcopy(value), self.assets())
                with self.assertRaises(MediaError):
                    media.mix_audio(value, self.assets(), None)

    def test_real_aac_small_tail_difference_is_zero_padded_with_warning(self):
        decoded = media.decode_audio(self.aac)
        count = decoded.shape[1]
        value = timeline(2)
        # 128 samples: model the common small container/timeline-vs-decode tail difference.
        value["audioSegments"] = [{"sourceStart": 0, "sourceEnd": (count + 128) / RATE, "start": 0}]
        output, warnings = media.mix_audio(value, {"recording": {"path": self.aac, "kind": "audio"}}, "recording")
        np.testing.assert_array_equal(output[:, :count], decoded)
        self.assertTrue(np.all(output[:, count:count + 128] == 0))
        self.assertTrue(any("AAC tail padding" in message for message in warnings))

    def test_large_aac_difference_and_non_aac_shortfall_are_not_hidden(self):
        count = media.decode_audio(self.aac).shape[1]
        value = timeline(2)
        value["audioSegments"] = [{"sourceStart": 0, "sourceEnd": count / RATE + .101, "start": 0}]
        with self.assertRaises(MediaError):
            media.mix_audio(value, {"recording": {"path": self.aac, "kind": "audio"}}, "recording")
        value["audioSegments"][0]["sourceEnd"] = 1 + 128 / RATE
        with self.assertRaises(MediaError):
            media.mix_audio(value, self.assets(), "recording")

    def test_source_cut_join_has_local_fades_without_ripple_or_speech_removal(self):
        value = timeline(1)
        value["audioSegments"] = [{"sourceStart": 0, "sourceEnd": .25, "start": 0},
                                  {"sourceStart": .5, "sourceEnd": .75, "start": .25}]
        source = media.decode_audio(self.short_sound)
        output, warnings = media.mix_audio(value, self.assets(), "recording")
        fade = round(media.JOIN_FADE_SECONDS * RATE)
        np.testing.assert_array_equal(output[:, :12000 - fade], source[:, :12000 - fade])
        np.testing.assert_array_equal(output[:, 12000 + fade:24000], source[:, 24000 + fade:36000])
        self.assertTrue(np.all(output[:, 11999:12001] == 0))
        self.assertTrue(np.all(output[:, 24000:] == 0))
        self.assertTrue(any("cut/join fade" in message for message in warnings))

    def test_warning_output_is_bounded_and_contains_no_input_paths(self):
        value = timeline(1)
        value["audioOverlays"] = [{"assetId": "effect", "start": 0, "gainDb": 12, "maxDuration": .5}] * 6
        output, warnings = media.mix_audio(value, self.assets(), None)
        self.assertLessEqual(np.abs(output).max(), 1)
        self.assertTrue(any("clipped" in message for message in warnings))
        result = renderer.render_warnings([{"code": "UNTRUSTED", "message": "C:/private/secret.key"}] * 100, warnings)
        self.assertLessEqual(len(result), 32)
        self.assertNotIn("private", " ".join(result))
        self.assertNotIn(str(self.output), " ".join(result))

    def test_painter_only_loads_cue_images_lazily_into_four_small_cache_entries(self):
        assets = {f"image{i}": {"path": self.image, "kind": "image"} for i in range(106)}
        value = timeline(6)
        value["cues"] = [{"start": index, "end": index + 1, "kind": "scene", "imageAssetId": f"image{index}"} for index in range(6)]
        with patch.object(renderer, "load_image", wraps=media.load_image) as loader:
            painter = renderer.Painter(value, assets)
            self.assertEqual(loader.call_count, 0)
            self.assertEqual(len(painter.assets), 6)
            for index in range(6):
                painter.draw(index + .1)
                self.assertLessEqual(len(painter.images), 4)
                self.assertTrue(all(image.width <= 282 and image.height <= 166 for image in painter.images.values()))
            self.assertEqual(loader.call_count, 6)
            self.assertTrue(all(call.kwargs.get("target_size") for call in loader.call_args_list))
            painter.draw(5.2)
            self.assertEqual(loader.call_count, 6, "Repeated frame reuses a resized image")
            self.assertLessEqual(sum(image.width * image.height * 3 for image in painter.images.values()), 4 * 282 * 166 * 3)

    def test_thumbnail_keeps_exif_rotated_image_inside_target(self):
        path = self.output / "rotated.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (1200, 400), "#b0c7a0").save(path, exif=exif)
        result = media.load_image(path, target_size=(100, 80))
        self.assertLessEqual(result.width, 100)
        self.assertLessEqual(result.height, 80)
        self.assertGreater(result.height, result.width)


if __name__ == "__main__":
    unittest.main()
