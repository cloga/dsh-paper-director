"""Format sniffing, bounded decoding, and deterministic timeline audio mixing."""
import warnings
import av
import numpy as np
from PIL import Image, ImageOps
from .safety import MAX_DURATION, MAX_PIXELS, MediaError, require, local_file, number

Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def sniff(path):
    with open(path, "rb") as source:
        header = source.read(64)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "PNG", "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image", "JPEG", "image/jpeg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image", "WEBP", "image/webp"
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "audio", "wav", "audio/wav"
    if header.startswith(b"fLaC"):
        return "audio", "flac", "audio/flac"
    if header.startswith(b"OggS"):
        return "audio", "ogg", "audio/ogg"
    if header.startswith(b"ID3") or (len(header) > 1 and header[0] == 255 and header[1] & 0xE0 == 0xE0):
        return "audio", "mp3", "audio/mpeg"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        return "media", "mov", "video/mp4"
    if header.startswith(b"\x1aE\xdf\xa3"):
        return "media", "matroska", "video/webm"
    raise MediaError("UNSUPPORTED_FORMAT", "Unsupported real media format; images, audio and MP4/WebM only.")


def open_media(path):
    kind, fmt, _ = sniff(path)
    require(kind != "image", "INVALID_MEDIA", "An audio or video asset is required.")
    # Force a signature-selected demuxer. Protocols and playlists cannot be selected by input.
    return av.open(str(path), mode="r", format=fmt, options={"protocol_whitelist": "file", "max_alloc": "268435456", "enable_drefs": "0", "use_absolute_path": "0"})


def load_image(path, target_size=None):
    kind, fmt, _ = sniff(path)
    require(kind == "image", "INVALID_MEDIA", "An image asset is required.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path, formats=[fmt]) as image:
            require(image.width * image.height <= MAX_PIXELS and max(image.size) <= 8192,
                    "LIMIT_EXCEEDED", "Image dimensions exceed limits.")
            require(getattr(image, "n_frames", 1) == 1, "UNSUPPORTED_FORMAT", "Animated images are not supported.")
            if target_size is not None:
                require(isinstance(target_size, tuple) and len(target_size) == 2
                        and all(isinstance(side, int) and 0 < side <= 8192 for side in target_size),
                        "INVALID_REQUEST", "Invalid image target dimensions.")
                # Reduce before transpose/convert; never retain a full source in the cache.
                orientation = image.getexif().get(274, 1)
                box = target_size[::-1] if orientation in (5, 6, 7, 8) else target_size
                image.thumbnail(box, Image.Resampling.LANCZOS, reducing_gap=3.0)
            else:
                image.load()
            return ImageOps.exif_transpose(image).convert("RGB")


def probe(value):
    path = local_file(value)
    kind, fmt, mime = sniff(path)
    if kind == "image":
        image = load_image(path)
        return {"kind": "image", "mime": mime, "format": fmt.lower(), "width": image.width,
                "height": image.height, "codec": fmt.lower(), "audioStreams": 0, "videoStreams": 0}
    with open_media(path) as container:
        audio, video = list(container.streams.audio), list(container.streams.video)
        require(0 < len(audio) + len(video) <= 4, "INVALID_MEDIA", "Invalid stream count.")
        require(len(audio) <= 1 and len(video) <= 1, "UNSUPPORTED_FORMAT", "Only one audio and one video stream are supported.")
        duration = float(container.duration / av.time_base) if container.duration else 0.0
        number(duration, "media duration")
        if not video and fmt in ("mov", "matroska"):
            mime = "audio/mp4" if fmt == "mov" else "audio/webm"
        result = {"kind": "video" if video else "audio", "format": fmt, "mime": mime,
                  "duration": duration, "audioStreams": len(audio), "videoStreams": len(video)}
        if video:
            stream = video[0]
            require(0 < stream.width * stream.height <= MAX_PIXELS and max(stream.width, stream.height) <= 8192,
                    "LIMIT_EXCEEDED", "Video dimensions exceed limits.")
            result.update(width=stream.width, height=stream.height, codec=stream.codec_context.name)
        if audio:
            stream = audio[0]
            channels = stream.codec_context.channels
            require(1 <= channels <= 8 and 8000 <= stream.codec_context.sample_rate <= 192000,
                    "LIMIT_EXCEEDED", "Audio channel or sample rate exceeds limits.")
            result.update(sampleRate=stream.codec_context.sample_rate, channels=channels)
            if not video:
                result["codec"] = stream.codec_context.name
        # Decode the full bounded stream so corrupt/truncated inputs are not accepted by extension/header alone.
        maxima = duration
        decoded = 0
        audio_seconds = 0.0
        for packet in container.demux():
            for frame in packet.decode():
                decoded += 1
                require(decoded <= 120000, "LIMIT_EXCEEDED", "Media decode frame limit exceeded.")
                at = float(frame.pts * frame.time_base) if frame.pts is not None else 0
                length = frame.samples / frame.sample_rate if isinstance(frame, av.AudioFrame) else 0
                if isinstance(frame, av.AudioFrame):
                    audio_seconds += length
                    require(audio_seconds <= MAX_DURATION + .1, "LIMIT_EXCEEDED", "Decoded audio duration exceeds limit.")
                else:
                    require(frame.width * frame.height <= MAX_PIXELS and max(frame.width, frame.height) <= 8192,
                            "LIMIT_EXCEEDED", "Decoded video dimensions exceed limits.")
                maxima = max(maxima, at + length, audio_seconds)
                require(maxima <= MAX_DURATION + .1, "LIMIT_EXCEEDED", "Media duration exceeds limit.")
        require(decoded > 0, "INVALID_MEDIA", "Media contains no decodable frames.")
        # Alignment and mixing both use decoded samples in their original order.
        # Browser Opus/AAC containers may have timestamp gaps or encoder padding;
        # advertising wall-clock maxima here makes valid recordings unrenderable.
        result["duration"] = audio_seconds if audio and not video else maxima
        if audio and not video:
            result.update(audioClock="decoded-samples", containerDuration=duration,
                          timestampDuration=maxima)
        return result


DEFAULT_OVERLAY_SECONDS = 10.0
MAX_OVERLAY_SECONDS = 600.0
OVERLAY_FADE_SECONDS = .010
JOIN_FADE_SECONDS = .005
AAC_PADDING_SECONDS = .100


def decode_audio(path, rate=48000, max_duration=None, info=None):
    """Decode once; optional bounded prefix never calls a full-file probe.

    A prefix may decode one additional codec frame to establish truncation, but retains
    at most max_duration samples. info is worker-owned metadata, never input file contents.
    """
    path = local_file(str(path))
    number(rate, "decode sample rate", 8000, 192000)
    limit = None if max_duration is None else round(number(max_duration, "audio prefix duration", 1 / rate, MAX_OVERLAY_SECONDS) * rate)
    chunks, count, truncated = [], 0, False
    codec, declared_duration = "", 0.0
    with open_media(path) as container:
        require(len(container.streams.audio) == 1 and len(container.streams.video) <= 1,
                "INVALID_MEDIA", "Asset must have one audio stream.")
        stream = container.streams.audio[0]
        codec = stream.codec_context.name
        require(1 <= stream.codec_context.channels <= 8 and 8000 <= stream.codec_context.sample_rate <= 192000,
                "LIMIT_EXCEEDED", "Audio channel or sample rate exceeds limits.")
        declared_duration = float(container.duration / av.time_base) if container.duration else 0.0
        number(declared_duration, "media duration")
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)

        def retain(converted):
            nonlocal count, truncated
            chunk = converted.to_ndarray()
            require(np.isfinite(chunk).all(), "INVALID_MEDIA", "Audio contains invalid samples.")
            remaining = chunk.shape[1] if limit is None else max(0, limit - count)
            take = min(chunk.shape[1], remaining)
            if take:
                # Copy the bounded slice: do not retain a large frame through a numpy view.
                chunks.append(chunk[:, :take].copy())
                count += take
                require(count <= round(rate * MAX_DURATION), "LIMIT_EXCEEDED", "Decoded audio exceeds limit.")
            if take < chunk.shape[1]:
                truncated = True
            return truncated

        decoded_frames = 0
        for frame in container.decode(audio=0):
            decoded_frames += 1
            require(decoded_frames <= 120000, "LIMIT_EXCEEDED", "Audio decode frame limit exceeded.")
            for converted in resampler.resample(frame):
                if retain(converted):
                    break
            if truncated:
                break
        if not truncated:
            for converted in resampler.resample(None):
                if retain(converted):
                    break
    require(chunks, "INVALID_MEDIA", "Audio has no samples.")
    samples = np.concatenate(chunks, axis=1)
    if info is not None:
        info.update(codec=codec, declaredDuration=declared_duration, decodedSamples=count,
                    decodedFrames=decoded_frames, truncated=truncated)
    return samples


def _fade_edge(samples, count, fade_in=False):
    """Short amplitude ramp only; no time shift, removed samples or voice inference."""
    count = min(count, samples.shape[1])
    if count <= 0:
        return
    ramp = np.linspace(0, 1, count, dtype=np.float32)
    if fade_in:
        samples[:, :count] *= ramp
    else:
        samples[:, -count:] *= ramp[::-1]


def mix_audio(timeline, assets, recording_id):
    rate = timeline["sampleRate"]
    output = np.zeros((2, round(timeline["duration"] * rate)), dtype=np.float32)
    notices = []
    pieces = timeline.get("audioSegments", [])
    if pieces:
        require(recording_id in assets and assets[recording_id]["kind"] == "audio", "INVALID_ASSET", "Recording asset is not mapped.")
        info = {}
        source = decode_audio(assets[recording_id]["path"], rate, info=info)
        wanted_end = max(round(piece["sourceEnd"] * rate) for piece in pieces)
        missing = max(0, wanted_end - source.shape[1])
        if missing > 1:
            require(info.get("codec") == "aac" and missing <= round(AAC_PADDING_SECONDS * rate),
                    "INVALID_TIMELINE", "Audio segment exceeds decoded recording duration beyond the allowed codec padding.")
            notices.append("AAC tail padding: at most 100 ms of missing end samples were filled with silence; review the ending.")
        elif missing:
            notices.append("Audio tail rounding: one missing end sample was filled with silence.")
        joins = 0
        previous = None
        for piece in pieces:
            left, right, start = (round(piece[key] * rate) for key in ("sourceStart", "sourceEnd", "start"))
            count = right - left
            require(left >= 0 and count > 0 and start >= 0 and start + count <= output.shape[1] + 1,
                    "INVALID_TIMELINE", "Audio segment exceeds timeline.")
            count = min(count, output.shape[1] - start)
            available = max(0, min(count, source.shape[1] - left))
            if available:
                output[:, start:start + available] += source[:, left:left + available]
            # Missing AAC tail stays zero in the exact compiled position; never shorten time.
            if previous is not None:
                prev_right, prev_start, prev_count = previous
                if start == prev_start + prev_count and abs(left - prev_right) > 1:
                    fade = min(round(JOIN_FADE_SECONDS * rate), prev_count // 2, count // 2)
                    _fade_edge(output[:, prev_start:start], fade)
                    _fade_edge(output[:, start:start + count], fade, fade_in=True)
                    joins += 1
            previous = (right, start, count)
        if joins:
            notices.append("Recording cut/join fade: 5 ms edge ramps were applied at discontinuous source joins without changing timing.")
        del source
    # Group by fixed resolved path: decode each distinct sound once to its largest required
    # prefix, reuse that bounded array for all placements, then release it before the next.
    groups = {}
    for overlay in timeline.get("audioOverlays", []):
        key = overlay["assetId"]
        require(key in assets and assets[key]["kind"] == "audio", "INVALID_ASSET", "Overlay audio asset is not mapped.")
        limit = number(overlay.get("maxDuration", DEFAULT_OVERLAY_SECONDS), "overlay maxDuration", 1 / rate, MAX_OVERLAY_SECONDS)
        start = round(number(overlay["start"], "overlay start", 0, timeline["duration"]) * rate)
        gain = number(overlay.get("gainDb", 0), "overlay gainDb", -96, 12)
        count = min(round(limit * rate), output.shape[1] - start)
        if count <= 0:
            continue
        source_path = assets[key]["path"]
        group = groups.setdefault(str(source_path), {"path": source_path, "placements": [], "count": 0})
        group["placements"].append((start, count, gain))
        group["count"] = max(group["count"], count)
    faded = False
    for group in groups.values():
        info = {}
        source = decode_audio(group["path"], rate, max_duration=group["count"] / rate, info=info)
        for start, maximum, gain in group["placements"]:
            count = min(source.shape[1], maximum)
            # Applying gain makes one bounded working copy; never mutate the cached prefix.
            piece = source[:, :count] * (10 ** (gain / 20))
            if count < source.shape[1] or info.get("truncated"):
                _fade_edge(piece, min(round(OVERLAY_FADE_SECONDS * rate), count // 2))
                faded = True
            output[:, start:start + count] += piece
        del source
    if faded:
        notices.append("Overlay duration cap: truncated sound effects received a 10 ms tail fade and do not extend beyond their compiled window.")
    if np.any(np.abs(output) > 1):
        notices.append("Audio mix exceeded full scale; clipped samples were limited to the valid audio range.")
    np.clip(output, -1, 1, out=output)
    return output, notices
