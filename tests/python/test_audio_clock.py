"""Generated codec timestamps must use the same decoded-sample clock as alignment/mixing."""
import sys
from pathlib import Path
from fractions import Fraction
import tempfile
import unittest
import av
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from paper_director.media import probe, decode_audio, mix_audio


class AudioClockTest(unittest.TestCase):
    def test_opus_timestamp_gap_does_not_make_recording_unrenderable(self):
        try:
            av.codec.Codec('libopus', 'w')
        except Exception:
            self.skipTest('Optional Opus encoder unavailable')
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'generated.webm'
            with av.open(str(target), 'w', format='webm') as mux:
                stream = mux.add_stream('libopus', rate=48000)
                stream.layout = 'mono'
                for index in range(50):
                    signal = np.sin((np.arange(960) + index * 960) / 48000 * 330 * np.pi * 2).astype(np.float32)[None, :] * .03
                    frame = av.AudioFrame.from_ndarray(signal, format='fltp', layout='mono')
                    frame.sample_rate = 48000
                    frame.time_base = Fraction(1, 48000)
                    frame.pts = index * 960 + (2400 if index >= 25 else 0)
                    for packet in stream.encode(frame):
                        mux.mux(packet)
                for packet in stream.encode(None):
                    mux.mux(packet)
            metadata = probe(str(target))
            audio = decode_audio(str(target), 48000)
            self.assertEqual(metadata['audioClock'], 'decoded-samples')
            self.assertAlmostEqual(metadata['duration'], audio.shape[1] / 48000, places=6)
            self.assertGreater(metadata['timestampDuration'] - metadata['duration'], .02)
            timeline = {'sampleRate': 48000, 'duration': metadata['duration'] + .2,
                        'audioSegments': [{'sourceStart': 0, 'sourceEnd': metadata['duration'], 'start': .1}],
                        'audioOverlays': []}
            mixed, warnings = mix_audio(timeline, {'recording': {'path': target, 'kind': 'audio'}}, 'recording')
            np.testing.assert_array_equal(mixed[:, 4800:4800 + audio.shape[1]], audio)
            self.assertFalse(any('missing' in str(w) for w in warnings))

    def test_aac_probe_and_decode_share_a_sample_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'generated.m4a'
            with av.open(str(target), 'w', format='mp4') as mux:
                stream = mux.add_stream('aac', rate=24000)
                stream.layout = 'mono'
                frame = av.AudioFrame.from_ndarray(np.zeros((1, 24000), dtype=np.float32), format='fltp', layout='mono')
                frame.sample_rate, frame.pts, frame.time_base = 24000, 0, Fraction(1, 24000)
                for packet in stream.encode(frame):
                    mux.mux(packet)
                for packet in stream.encode(None):
                    mux.mux(packet)
            metadata = probe(str(target))
            audio = decode_audio(str(target), 48000)
            self.assertAlmostEqual(metadata['duration'], audio.shape[1] / 48000, delta=1 / 48000)


if __name__ == '__main__':
    unittest.main()
