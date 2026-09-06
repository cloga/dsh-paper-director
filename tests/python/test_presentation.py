"""Presentation/cache regressions using synthetic paper images and generated silence."""
from pathlib import Path
import math
import sys
import unittest
from unittest.mock import patch

import av
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from paper_director import renderer
from paper_director.fonts import choose_font
from paper_director.safety import MediaError


def timeline(duration=3, fps=25, chinese=False):
    return {"width": 640, "height": 480, "fps": fps, "duration": duration, "sampleRate": 48000,
            "introSeconds": .5, "outroSeconds": 1, "title": "纸偶的电影" if chinese else "A Paper Movie",
            "credits": {"director": "匿名导演" if chinese else "Anonymous Director", "voice": "合成声音" if chinese else "Synthetic Voice"},
            "characters": [], "cues": [], "subtitles": [], "audioSegments": [], "audioOverlays": [], "warnings": []}


class PresentationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output = ROOT / "tests" / "python" / ".artifacts" / "presentation"
        cls.output.mkdir(parents=True, exist_ok=True)
        cls.image_path = cls.output / "anonymous-paper.png"
        Image.new("RGB", (400, 300), "#9bbbaa").save(cls.image_path)
        cls.assets = {"paper": {"path": cls.image_path, "kind": "image"}}

    def test_chinese_intro_and_outro_include_actual_author_and_voice_credits(self):
        value = timeline(chinese=True)
        with patch.object(renderer, "choose_font", wraps=choose_font) as readiness:
            painter = renderer.Painter(value, {})
        checked = " ".join(readiness.call_args.args[1])
        for template in ("导演", "配音", "完", "谢谢观看"):
            self.assertIn(template, checked)
        with patch.object(painter, "block", wraps=painter.block) as blocks:
            painter.draw(.1)
            intro_text = "\n".join(call.args[1] for call in blocks.call_args_list)
        self.assertIn("导演  匿名导演", intro_text)
        self.assertIn("配音  合成声音", intro_text)
        self.assertNotIn("DIRECTOR", intro_text)
        with patch.object(painter, "block", wraps=painter.block) as blocks:
            painter.draw(2.1)
            outro_text = "\n".join(call.args[1] for call in blocks.call_args_list)
        self.assertIn("完", outro_text)
        self.assertIn("谢谢观看", outro_text)
        self.assertIn("导演  匿名导演", outro_text)
        self.assertIn("配音  合成声音", outro_text)
        painter.draw(.1).save(self.output / "chinese-intro.png")
        painter.draw(2.1).save(self.output / "chinese-outro.png")

    def test_english_project_does_not_require_chinese_template_glyphs(self):
        value = timeline()
        with patch.object(renderer, "choose_font", wraps=choose_font) as readiness:
            painter = renderer.Painter(value, {})
        texts = " ".join(readiness.call_args.args[1])
        self.assertFalse(painter.cjk)
        self.assertIn("DIRECTOR", texts)
        self.assertIn("VOICE", texts)
        self.assertIn("THE END", texts)
        self.assertNotIn("导演", texts)
        self.assertTrue(all(ord(char) < 128 for char in texts))

    def test_missing_actual_template_glyphs_fail_before_drawing(self):
        def reject_missing_template(font_path, texts):
            self.assertIn("谢谢观看", texts)
            raise MediaError("FONT_GLYPHS_MISSING", "Required template glyphs are unavailable.")
        with patch.object(renderer, "choose_font", side_effect=reject_missing_template):
            with self.assertRaisesRegex(MediaError, "template glyphs"):
                renderer.Painter(timeline(chinese=True), {})

    def test_fade_is_smooth_bounded_and_last_sample_black_without_shortening_outro(self):
        value = timeline(duration=2.13, fps=25, chinese=True)
        value["introSeconds"], value["outroSeconds"] = .4, .8
        painter = renderer.Painter(value, {})
        last_time = (math.ceil(value["duration"] * value["fps"]) - 1) / value["fps"]
        self.assertEqual(painter.outro_brightness(value["duration"] - .501), 1)
        times = [1.63, 1.7, 1.85, 2.0, last_time]
        means = [np.asarray(painter.draw(time)).mean() for time in times]
        self.assertTrue(all(left > right for left, right in zip(means, means[1:])))
        self.assertEqual(means[-1], 0)
        self.assertEqual(np.asarray(painter.draw(value["duration"])).max(), 0)
        self.assertEqual(value["duration"], 2.13)
        self.assertEqual(value["outroSeconds"], .8)
        short = timeline(duration=1.23, fps=25)
        short["introSeconds"], short["outroSeconds"] = 0, .2
        short_painter = renderer.Painter(short, {})
        self.assertEqual(short_painter.outro_brightness(1.02), 1)
        self.assertEqual(np.asarray(short_painter.draw(1.2)).max(), 0)
        short["outroSeconds"] = 0
        self.assertGreater(np.asarray(renderer.Painter(short, {}).draw(1.2)).max(), 0)

    def render_counted(self, value, name):
        output = self.output / name
        output.mkdir(exist_ok=True)
        calls = []
        original = renderer.Painter.draw
        def counted(painter, time):
            calls.append(time)
            return original(painter, time)
        with patch.object(renderer.Painter, "draw", new=counted):
            result = renderer.render({"action": "render", "timeline": value, "assets": {}, "recordingAssetId": None}, output, self.assets, lambda *_: None)
        return calls, output, result

    def test_static_encoding_reuses_one_composition_not_one_per_video_frame(self):
        value = timeline(duration=2, fps=25)
        value["introSeconds"] = value["outroSeconds"] = 0
        value["cues"] = [{"start": 0, "end": 2, "kind": "scene", "imageAssetId": "paper"}]
        calls, output, result = self.render_counted(value, "static")
        self.assertEqual(calls, [0])
        self.assertEqual(result["frameCount"], 50)
        with av.open(str(output / "movie.mp4")) as movie:
            frames = list(movie.decode(video=0))
            self.assertEqual(len(frames), 50)
            first = frames[0].to_ndarray(format="rgb24").astype(np.float32)
            last = frames[-1].to_ndarray(format="rgb24").astype(np.float32)
            self.assertLess(np.abs(first - last).mean(), 2)  # Normal inter-frame codec quantization.

    def test_cache_key_includes_every_active_subtitle_and_cue_index(self):
        value = timeline(duration=2, fps=10)
        value["introSeconds"] = value["outroSeconds"] = 0
        value["cues"] = [{"start": 0, "end": 1.5, "kind": "scene", "imageAssetId": "paper"},
                         {"start": 1.5, "end": 2, "kind": "scene", "imageAssetId": "paper"}]
        value["subtitles"] = [{"start": 0, "end": 1.2, "text": "A", "characterId": "narrator", "mode": "normal"},
                              {"start": .4, "end": .8, "text": "B", "characterId": "narrator", "mode": "thought"}]
        painter = renderer.Painter(value, self.assets)
        self.assertNotEqual(painter.frame_key(.3), painter.frame_key(.4))
        self.assertNotEqual(painter.frame_key(.7), painter.frame_key(.8))
        self.assertNotEqual(painter.frame_key(1.4), painter.frame_key(1.5))
        calls, _, _ = self.render_counted(value, "subtitles")
        self.assertEqual(calls, [0, .4, .8, 1.2, 1.5])

    def test_dynamic_magic_and_fade_redraw_while_intro_outro_static_parts_reuse(self):
        value = timeline(duration=3, fps=10, chinese=True)
        value["cues"] = [{"start": .5, "end": 1, "kind": "scene", "imageAssetId": "paper"},
                         {"start": 1, "end": 1.5, "kind": "magic", "imageAssetId": "paper"},
                         {"start": 1.5, "end": 2, "kind": "scene", "imageAssetId": "paper"}]
        painter = renderer.Painter(value, self.assets)
        calls, output, result = self.render_counted(value, "dynamic")
        self.assertEqual(calls, [0, .5, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 2, 2.6, 2.7, 2.8, 2.9])
        self.assertEqual(result["frameCount"], 30)
        self.assertEqual(result["duration"], 3)
        self.assertIsNone(painter.frame_key(1.1))
        self.assertIsNone(painter.frame_key(2.7))
        with av.open(str(output / "movie.mp4")) as movie:
            frames = list(movie.decode(video=0))
            self.assertEqual(len(frames), 30)
            self.assertEqual(frames[-1].to_ndarray(format="rgb24").max(), 0)
            # Shared frame path matches Painter exactly; compressed movie stays close.
            expected = np.asarray(painter.draw(2.7), dtype=np.float32)
            actual = frames[27].to_ndarray(format="rgb24").astype(np.float32)
            self.assertLess(np.abs(expected - actual).mean(), 8)
        frame_dir = self.output / "frame"
        frame_dir.mkdir(exist_ok=True)
        renderer.render({"action": "frame", "timeline": value, "time": 2.7}, frame_dir, self.assets, lambda *_: None)
        np.testing.assert_array_equal(np.asarray(Image.open(frame_dir / "frame.png")), np.asarray(painter.draw(2.7)))


if __name__ == "__main__":
    unittest.main()
