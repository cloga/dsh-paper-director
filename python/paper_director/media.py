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


def load_image(path):
    kind, fmt, _ = sniff(path)
    require(kind == "image", "INVALID_MEDIA", "An image asset is required.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path, formats=[fmt]) as image:
            require(image.width * image.height <= MAX_PIXELS and max(image.size) <= 8192,
                    "LIMIT_EXCEEDED", "Image dimensions exceed limits.")
            require(getattr(image, "n_frames", 1) == 1, "UNSUPPORTED_FORMAT", "Animated images are not supported.")
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
        result["duration"] = maxima
        return result


def decode_audio(path, rate=48000):
    meta = probe(str(path))
    require(meta["audioStreams"] == 1, "INVALID_MEDIA", "Asset has no audio stream.")
    chunks = []
    count = 0
    with open_media(path) as container:
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                chunk = converted.to_ndarray()
                count += chunk.shape[1]
                require(count <= int(rate * MAX_DURATION), "LIMIT_EXCEEDED", "Decoded audio exceeds limit.")
                chunks.append(chunk)
        for converted in resampler.resample(None):
            chunks.append(converted.to_ndarray())
    require(chunks, "INVALID_MEDIA", "Audio has no samples.")
    samples = np.concatenate(chunks, axis=1)
    require(np.isfinite(samples).all(), "INVALID_MEDIA", "Audio contains invalid samples.")
    return samples


def mix_audio(timeline, assets, recording_id):
    rate = timeline["sampleRate"]
    output = np.zeros((2, round(timeline["duration"] * rate)), dtype=np.float32)
    pieces = timeline.get("audioSegments", [])
    if pieces:
        require(recording_id in assets and assets[recording_id]["kind"] == "audio", "INVALID_ASSET", "Recording asset is not mapped.")
        source = decode_audio(assets[recording_id]["path"], rate)
        for piece in pieces:
            left, right, start = (round(piece[key] * rate) for key in ("sourceStart", "sourceEnd", "start"))
            require(right <= source.shape[1] + 1, "INVALID_TIMELINE", "Audio segment exceeds recording duration.")
            count = min(right, source.shape[1]) - left
            require(start + count <= output.shape[1] + 1, "INVALID_TIMELINE", "Audio segment exceeds timeline.")
            count = min(count, output.shape[1] - start)
            output[:, start:start + count] += source[:, left:left + count]
    for overlay in timeline.get("audioOverlays", []):
        key = overlay["assetId"]
        require(key in assets and assets[key]["kind"] == "audio", "INVALID_ASSET", "Overlay audio asset is not mapped.")
        source = decode_audio(assets[key]["path"], rate)
        start = round(overlay["start"] * rate)
        count = min(source.shape[1], output.shape[1] - start)
        output[:, start:start + count] += source[:, :count] * (10 ** (overlay["gainDb"] / 20))
    clipped = int(np.count_nonzero(np.abs(output) > 1))
    np.clip(output, -1, 1, out=output)
    return output, (["Audio mix exceeded full scale; clipped samples: " + str(clipped)] if clipped else [])
