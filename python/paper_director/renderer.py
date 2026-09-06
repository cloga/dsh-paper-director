"""Shared Pillow scene drawing and PyAV H.264/AAC timeline encoding."""
from collections import OrderedDict
from fractions import Fraction
import math
import re
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from .fonts import choose_font
from .media import load_image, mix_audio, DEFAULT_OVERLAY_SECONDS, MAX_OVERLAY_SECONDS
from .safety import require, number, integer, text, identifier


def validate_timeline(timeline, assets):
    require(isinstance(timeline, dict), "INVALID_TIMELINE", "Timeline must be an object.")
    width = integer(timeline.get("width"), "width", 160, 3840)
    height = integer(timeline.get("height"), "height", 120, 2160)
    require(width % 2 == height % 2 == 0 and width * height <= 8_294_400,
            "INVALID_TIMELINE", "Output dimensions must be even and bounded.")
    fps = integer(timeline.get("fps"), "fps", 1, 60)
    duration = number(timeline.get("duration"), "duration", .01, 1800)
    require(math.ceil(duration * fps) <= 108000 and width * height * math.ceil(duration * fps) <= 150_000_000_000,
            "LIMIT_EXCEEDED", "Render pixel-frame budget exceeded.")
    require(timeline.get("sampleRate", 48000) == 48000, "INVALID_TIMELINE", "Timeline sampleRate must be 48000.")
    timeline["sampleRate"] = 48000
    intro = number(timeline.get("introSeconds", 0), "introSeconds", 0, duration)
    outro = number(timeline.get("outroSeconds", 0), "outroSeconds", 0, duration)
    require(intro + outro <= duration + 1e-6, "INVALID_TIMELINE", "Intro/outro exceed timeline.")
    text(timeline.get("title", ""), "title", 200)
    credits = timeline.get("credits", {})
    require(isinstance(credits, dict), "INVALID_TIMELINE", "Invalid credits.")
    for name in ("director", "voice"):
        text(credits.get(name, ""), "credit", 200)
    characters = timeline.get("characters", [])
    require(isinstance(characters, list) and len(characters) <= 64, "INVALID_TIMELINE", "Invalid characters.")
    ids = {"both", "narrator"}
    for character in characters:
        require(isinstance(character, dict), "INVALID_TIMELINE", "Invalid character.")
        key = identifier(character.get("id"))
        require(key not in ids, "INVALID_TIMELINE", "Duplicate or reserved character id.")
        ids.add(key)
        text(character.get("name"), "character name", 80)
        require(re.fullmatch(r"#[0-9a-fA-F]{6}", character.get("color", "#e8b35c")) is not None, "INVALID_TIMELINE", "Character color must be #RRGGBB.")
    for field, limit in (("cues", 2048), ("subtitles", 4096), ("audioSegments", 4096), ("audioOverlays", 256)):
        entries = timeline.get(field, [])
        require(isinstance(entries, list) and len(entries) <= limit, "INVALID_TIMELINE", "Invalid timeline entries.")
        last_end = 0
        for entry in entries:
            require(isinstance(entry, dict), "INVALID_TIMELINE", "Invalid timeline entry.")
            start = number(entry.get("start"), field + " start", 0, duration)
            if field in ("cues", "subtitles"):
                end = number(entry.get("end"), field + " end", 0, duration)
                require(start < end, "INVALID_TIMELINE", "Empty or reversed timeline range.")
            if field == "cues":
                require(start >= last_end - 1e-6, "INVALID_TIMELINE", "Scene cues cannot overlap or be unordered.")
                last_end = end
                require(entry.get("kind") in ("scene", "magic", "time"), "INVALID_TIMELINE", "Unknown cue kind.")
                if entry.get("imageAssetId") is not None:
                    require(entry["imageAssetId"] in assets and assets[entry["imageAssetId"]]["kind"] == "image", "INVALID_ASSET", "Cue image is not mapped.")
                require(entry.get("kind") != "scene" or entry.get("imageAssetId") in assets,
                        "INVALID_ASSET", "Scene needs a mapped image.")
                text(entry.get("timeLabel", ""), "time label", 200)
            elif field == "subtitles":
                text(entry.get("text"), "subtitle", 4000)
                require(entry.get("characterId") in ids and entry.get("mode", "normal") in ("normal", "thought", "small", "burst"),
                        "INVALID_TIMELINE", "Invalid subtitle role or mode.")
            elif field == "audioSegments":
                left = number(entry.get("sourceStart"), "sourceStart")
                right = number(entry.get("sourceEnd"), "sourceEnd")
                require(left < right and start + right - left <= duration + 1e-6 and start >= last_end - 1e-6,
                        "INVALID_TIMELINE", "Invalid or overlapping compiled audio segment.")
                last_end = start + right - left
            else:
                require(entry.get("assetId") in assets, "INVALID_ASSET", "Overlay is not mapped.")
                number(entry.get("gainDb", 0), "gainDb", -96, 12)
                number(entry.get("maxDuration", DEFAULT_OVERLAY_SECONDS), "overlay maxDuration", 1 / 48000, MAX_OVERLAY_SECONDS)
                entry.setdefault("gainDb", 0)
    require(isinstance(timeline.get("warnings", []), list) and len(timeline.get("warnings", [])) <= 256,
            "INVALID_TIMELINE", "Timeline warnings must be a bounded list.")
    return timeline


def render_warnings(timeline_warnings, audio_warnings):
    """Only fixed worker text leaves the renderer; input warning messages can contain paths."""
    known = {
        "ALIGNMENT_NEEDS_REVIEW": "Some dialogue timings need listening review before publication.",
        "UNMATCHED_SPEECH_RETAINED": "Unmatched speech was retained in the recording; do not treat it as silence.",
    }
    safe_demo = "Synthetic tones are not speech; captions are provided author text, not ASR."
    result = []
    for warning in timeline_warnings:
        code = warning.get("code") if isinstance(warning, dict) else None
        message = safe_demo if warning == safe_demo else known.get(code, "The compiled timeline contains review warnings; check the edit before publication.")
        if message not in result:
            result.append(message)
    for message in audio_warnings:
        if message not in result:
            result.append(message)
    return result[:32]


class Painter:
    def __init__(self, timeline, assets, font_path=None):
        self.timeline = timeline
        referenced = {cue.get("imageAssetId") for cue in timeline.get("cues", []) if cue.get("imageAssetId")}
        self.assets = {key: assets[key] for key in referenced if key in assets}
        self.width, self.height = timeline["width"], timeline["height"]
        self.scale = min(self.width / 1280, self.height / 960)
        self.characters = {c["id"]: c for c in timeline.get("characters", [])}
        texts = [timeline.get("title", "")]
        texts += [str(v) for k, v in timeline.get("credits", {}).items() if k in ("director", "voice")]
        texts += [c["name"] for c in self.characters.values()]
        texts += [s["text"] for s in timeline.get("subtitles", [])]
        texts += [c.get("timeLabel", "") for c in timeline.get("cues", [])]
        self.cjk = any(re.search(r"[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0003134f]", value) for value in texts)
        self.labels = ({"director": "导演", "voice": "配音", "end": "完", "thanks": "谢谢观看", "time": "时间", "narrator": "旁白"}
                       if self.cjk else {"director": "DIRECTOR", "voice": "VOICE", "end": "THE END", "thanks": "THANK YOU FOR WATCHING", "time": "TIME", "narrator": "NARRATOR"})
        # Validate the actual selected language template too, before any frames are made.
        texts += list(self.labels.values())
        self.font_path = choose_font(font_path, texts)
        self.fonts, self.images = {}, OrderedDict()
        # Deterministic paper grain, shared by previews, frame and full exports.
        rng = np.random.default_rng(481)
        grain = rng.integers(-4, 5, (self.height, self.width, 1), dtype=np.int16)
        self.paper = Image.fromarray(np.clip(np.array([244, 234, 211]) + grain, 0, 255).astype(np.uint8), "RGB")

    def font(self, size):
        size = max(10, round(size * self.scale))
        if size not in self.fonts:
            self.fonts[size] = ImageFont.truetype(str(self.font_path), size)
        return self.fonts[size]

    def wrap(self, draw, value, font, width):
        lines = []
        for paragraph in value.split("\n"):
            line = ""
            for char in paragraph:
                if line and draw.textlength(line + char, font=font) > width:
                    lines.append(line)
                    line = char
                else:
                    line += char
            lines.append(line)
        return lines

    def block(self, draw, value, box, size=48, fill="#292b38", center=True):
        x0, y0, x1, y1 = box
        for candidate in range(size, 11, -2):
            font = self.font(candidate)
            lines = self.wrap(draw, value, font, x1 - x0)
            line_height = sum(font.getmetrics()) + max(2, round(6 * self.scale))
            if line_height * len(lines) <= y1 - y0:
                break
        require(line_height * len(lines) <= y1 - y0, "TEXT_OVERFLOW", "Text cannot fit the frame; shorten text or increase output dimensions.")
        y = y0 + ((y1 - y0 - len(lines) * line_height) / 2 if center else 0)
        for line in lines:
            x = x0 + ((x1 - x0 - draw.textlength(line, font=font)) / 2 if center else 0)
            draw.text((x, y), line, font=font, fill=fill)
            y += line_height

    def image(self, asset_id, size):
        key = (asset_id, size)
        if key not in self.images:
            require(asset_id in self.assets, "INVALID_ASSET", "Only cue-referenced images may be drawn.")
            # Evict before loading: at most four output-sized rasters, never project-wide
            # originals. Source decode/downscale occurs only when a cue needs this image.
            while len(self.images) >= 4:
                _, old = self.images.popitem(last=False)
                old.close()
            self.images[key] = load_image(self.assets[asset_id]["path"], target_size=size)
        self.images.move_to_end(key)
        return self.images[key]

    def credits_text(self):
        credits = self.timeline.get("credits", {})
        return "\n".join(self.labels[key] + "  " + credits[key]
                         for key in ("director", "voice") if credits.get(key))

    def outro_brightness(self, time):
        """Fade only the requested outro, ending on the last actual video sample."""
        duration = self.timeline["duration"]
        outro = self.timeline.get("outroSeconds", 0)
        if outro <= 0:
            return 1.0
        last_time = (math.ceil(duration * self.timeline["fps"]) - 1) / self.timeline["fps"]
        if time >= last_time:
            return 0.0
        fade_start = max(duration - min(.5, outro), 0)
        if time <= fade_start or last_time <= fade_start:
            return 1.0
        fraction = (time - fade_start) / (last_time - fade_start)
        return 1 - fraction * fraction * (3 - 2 * fraction)

    def frame_key(self, time):
        """None means dynamic. Indices keep all simultaneous subtitle changes visible."""
        brightness = self.outro_brightness(time)
        if brightness == 0:
            return ("black",)
        if brightness < 1:
            return None
        if time < self.timeline.get("introSeconds", 0):
            return ("intro",)
        if time >= self.timeline["duration"] - self.timeline.get("outroSeconds", 0):
            return ("outro",)
        cue_index = next((i for i, cue in enumerate(self.timeline.get("cues", []))
                          if cue["start"] <= time < cue["end"]), None)
        if cue_index is not None and self.timeline["cues"][cue_index]["kind"] == "magic":
            return None
        active = tuple(i for i, subtitle in enumerate(self.timeline.get("subtitles", []))
                       if subtitle["start"] <= time < subtitle["end"])
        return ("scene", cue_index, active)

    def draw(self, time):
        brightness = self.outro_brightness(time)
        if brightness == 0:
            return Image.new("RGB", (self.width, self.height), "black")
        image = self.paper.copy()
        draw = ImageDraw.Draw(image)
        w, h, scale = self.width, self.height, self.scale
        border = max(3, round(8 * scale))
        margin = max(8, round(32 * scale))
        draw.rectangle((margin, margin, w - margin, h - margin), outline="#302c28", width=border)
        timeline = self.timeline
        if time < timeline.get("introSeconds", 0):
            self.block(draw, timeline.get("title", ""), (w * .12, h * .22, w * .88, h * .68), 78)
            credits = self.credits_text()
            if credits:
                self.block(draw, credits, (w * .15, h * .70, w * .85, h * .90), 32)
            return image
        if time >= timeline["duration"] - timeline.get("outroSeconds", 0):
            self.block(draw, self.labels["end"], (w * .15, h * .18, w * .85, h * .43), 84)
            self.block(draw, self.labels["thanks"], (w * .15, h * .44, w * .85, h * .54), 32)
            credits = self.credits_text()
            if credits:
                self.block(draw, credits, (w * .12, h * .57, w * .88, h * .87), 36)
            if brightness < 1:
                faded = image.point([round(value * brightness) for value in range(256)] * 3)
                image.close()
                return faded
            return image
        cue = next((c for c in timeline.get("cues", []) if c["start"] <= time < c["end"]), None)
        if cue:
            asset_id = cue.get("imageAssetId")
            if asset_id:
                region = (round(w * .88), round(h * .69))
                picture = self.image(asset_id, region)
                x, y = (w - picture.width) // 2, round(h * .07)
                draw.rectangle((x - border, y - border, x + picture.width + border * 2, y + picture.height + border * 2), fill="#827a6c")
                image.paste(picture, (x, y))
                draw.rectangle((x - border, y - border, x + picture.width + border, y + picture.height + border), outline="#fff9e9", width=border)
            if cue["kind"] == "time":
                draw.rounded_rectangle((w * .10, h * .28, w * .90, h * .63), radius=round(18 * scale), fill="#fff9e9", outline="#302c28", width=border)
                self.block(draw, cue.get("timeLabel") or self.labels["time"], (w * .14, h * .31, w * .86, h * .60), 64)
            elif cue["kind"] == "magic":
                phase = (time - cue["start"]) / (cue["end"] - cue["start"])
                cx, cy = w / 2, h * .40
                radius = min(w, h) * (.08 + .44 * phase)
                for ring in range(5):
                    r = radius + ring * 12 * scale
                    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=("#8d64d8" if ring % 2 else "#fff5ab"), width=max(2, round((7 - ring) * scale)))
                for star in range(12):
                    angle = star * math.tau / 12 + phase * 2
                    x, y = cx + math.cos(angle) * radius, cy + math.sin(angle) * radius
                    d = max(3, round(10 * scale))
                    draw.line((x - d, y, x + d, y), fill="#fffdf3", width=border)
                    draw.line((x, y - d, x, y + d), fill="#fffdf3", width=border)
        active = [s for s in timeline.get("subtitles", []) if s["start"] <= time < s["end"]]
        # Active name badges identify script labels, never acoustic identities.
        active_ids = {s["characterId"] for s in active}
        if "both" in active_ids:
            active_ids.update(list(self.characters)[:2])
        visible = list(self.characters.values())[:4]
        for index, character in enumerate(visible):
            bw = min(w * .20, 230 * scale)
            x = margin + (bw + 8 * scale) * index + 8 * scale
            y = margin + 8 * scale
            selected = character["id"] in active_ids
            draw.rounded_rectangle((x, y, x + bw, y + 48 * scale), radius=max(2, round(8 * scale)),
                                   fill=character.get("color", "#e8b35c") if selected else "#eee4d1", outline="#302c28", width=border if selected else 1)
            self.block(draw, character["name"], (x + 3, y, x + bw - 3, y + 48 * scale), 26)
        if active:
            require(len(active) <= 3, "TEXT_OVERFLOW", "At most three simultaneous subtitle bubbles are supported.")
            for index, subtitle in enumerate(active):
                mode = subtitle.get("mode", "normal")
                thought = mode == "thought"
                box_width = w * (.63 if thought or mode == "small" else .87)
                left = (w - box_width) / 2
                y0, y1 = h * .77, h * .93
                # Simultaneous lines use separate stacked bubbles, never silently discard speech.
                if len(active) > 1:
                    y0 = h * (.52 + index * .14)
                    y1 = y0 + h * .13
                fill = "#fff3b8" if mode == "burst" else "#fffdf5"
                if thought:
                    draw.rounded_rectangle((left, y0, left + box_width, y1), radius=max(3, round(32 * scale)), fill=fill, outline="#302c28", width=border)
                    for j in range(3):
                        r = (8 - j * 2) * scale
                        x, y = left + 30 * scale - j * 13 * scale, y0 - (j + 1) * 12 * scale
                        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill, outline="#302c28", width=1)
                elif mode == "burst":
                    points = []
                    for j in range(40):
                        angle = j * math.tau / 40
                        factor = 1 if j % 2 else 1.08
                        points.append((w / 2 + math.cos(angle) * box_width / 2 * factor,
                                       (y0 + y1) / 2 + math.sin(angle) * (y1 - y0) / 2 * factor))
                    draw.polygon(points, fill=fill, outline="#302c28", width=border)
                else:
                    draw.rounded_rectangle((left, y0, left + box_width, y1), radius=max(3, round(12 * scale)), fill=fill, outline="#302c28", width=border)
                character_id = subtitle["characterId"]
                name = self.characters.get(character_id, {}).get("name", self.labels["narrator"] if character_id == "narrator" else " / ".join(c["name"] for c in list(self.characters.values())[:2]))
                self.block(draw, name + ": " + subtitle["text"], (left + box_width * .06, y0 + 3 * scale, left + box_width * .94, y1 - 3 * scale), 36 if mode in ("small", "thought") else 44)
        return image


def render(request, output_dir, assets, progress):
    timeline = validate_timeline(request.get("timeline"), assets)
    painter = Painter(timeline, assets, request.get("fontPath"))
    if request["action"] == "frame":
        time = number(request.get("time"), "frame time", 0, timeline["duration"])
        painter.draw(min(time, max(0, timeline["duration"] - 1e-9))).save(output_dir / "frame.png", format="PNG")
        return {"path": "frame.png", "width": painter.width, "height": painter.height, "time": time}
    progress(.08, "audio", "Applying authoritative compiled audio segments and overlays.")
    audio, warnings = mix_audio(timeline, assets, request.get("recordingAssetId"))
    rate, fps = timeline["sampleRate"], timeline["fps"]
    frame_count = math.ceil(timeline["duration"] * fps)
    with av.open(str(output_dir / "movie.mp4"), "w", format="mp4", options={"movflags": "+faststart"}) as output:
        video = output.add_stream("libx264", rate=fps)
        video.width, video.height, video.pix_fmt = painter.width, painter.height, "yuv420p"
        video.codec_context.thread_count = 2
        video.codec_context.color_range = 1
        video.codec_context.colorspace = 1
        video.codec_context.color_primaries = 1
        video.codec_context.color_trc = 1
        video.options = {"crf": "22" if request.get("preview") else "18", "preset": "veryfast"}
        sound = output.add_stream("aac", rate=rate)
        sound.layout = "stereo"
        sound.bit_rate = 192000
        converter = av.video.reformatter.VideoReformatter()
        audio_position = 0
        composed, composed_key = None, None
        for index in range(frame_count):
            time = index / fps
            key = painter.frame_key(time)
            if composed is None or key is None or key != composed_key:
                if composed is not None:
                    composed.close()
                composed = painter.draw(time)
                composed_key = key
            frame = av.VideoFrame.from_image(composed)
            frame = converter.reformat(frame, format="yuv420p", src_colorspace="ITU709", dst_colorspace="ITU709", src_color_range="JPEG", dst_color_range="MPEG", dst_color_trc=1, dst_color_primaries=1)
            frame.pts, frame.time_base = index, Fraction(1, fps)
            frame.color_range, frame.colorspace = 1, 1
            for packet in video.encode(frame):
                output.mux(packet)
            boundary = min(audio.shape[1], math.ceil((index + 1) * rate / fps))
            while audio_position < boundary:
                end = min(audio_position + 1024, audio.shape[1])
                sound_frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(audio[:, audio_position:end]), format="fltp", layout="stereo")
                sound_frame.sample_rate, sound_frame.time_base, sound_frame.pts = rate, Fraction(1, rate), audio_position
                for packet in sound.encode(sound_frame):
                    output.mux(packet)
                audio_position = end
            if index % max(1, fps) == 0:
                progress(.1 + .85 * index / frame_count, "render", f"Encoded {index + 1}/{frame_count} frames.")
        if composed is not None:
            composed.close()
        for packet in video.encode(None):
            output.mux(packet)
        for packet in sound.encode(None):
            output.mux(packet)
    return {"path": "movie.mp4", "width": painter.width, "height": painter.height, "fps": fps,
            "duration": timeline["duration"], "frameCount": frame_count, "videoCodec": "h264", "audioCodec": "aac",
            "colorSpace": "bt709", "colorRange": "limited", "warnings": render_warnings(timeline.get("warnings", []), warnings),
            "preview": bool(request.get("preview", False))}
