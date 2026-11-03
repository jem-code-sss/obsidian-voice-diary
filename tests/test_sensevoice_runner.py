"""Offline regression tests; uses NumPy but never loads a speech model."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
import wave

import numpy as np

RUNNER = Path(__file__).resolve().parents[1] / 'runtime' / 'sensevoice_runner.py'
SPEC = importlib.util.spec_from_file_location('sensevoice_runner_tests', RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def write_wav(path, samples):
    with wave.open(str(path), 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(np.asarray(samples, dtype='<i2').tobytes())


class Recognizer:
    def __init__(self, text='听得见。'):
        self.text = text
        self.calls = 0
        self.waveforms = []

    def create_stream(self):
        return types.SimpleNamespace(
            accept_waveform=lambda rate, data: self.waveforms.append((rate, data.copy())),
            result=types.SimpleNamespace(text=self.text))

    def decode_stream(self, stream):
        self.calls += 1


class DecodeTests(unittest.TestCase):
    def setUp(self):
        runner.CANCELLED.clear()
        self.folder = tempfile.TemporaryDirectory(prefix='sensevoice-runner-test-')
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'audio.wav'

    def decode(self, recognizer):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = runner.decode(recognizer, self.path)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        return result, events

    def test_digital_silence_never_calls_recognizer_and_reaches_complete_progress(self):
        # Includes more than one chunk so a silent gap cannot stall progress.
        write_wav(self.path, np.zeros(40 * 16000, dtype=np.int16))
        recognizer = Recognizer('不能凭空出现这句话。')
        text, events = self.decode(recognizer)
        self.assertEqual(text, '')
        self.assertEqual(recognizer.calls, 0)
        self.assertEqual(recognizer.waveforms, [])
        self.assertGreater(len(events), 1)
        self.assertEqual(events[-1], {'event': 'progress', 'pct': 100})

    def test_punctuation_only_results_are_ignored(self):
        write_wav(self.path, np.ones(1600, dtype=np.int16))
        for text in ('。', ' ，！？…—「」 \n', '<|zh|><|Speech|>。。。'):
            with self.subTest(text=text):
                recognizer = Recognizer(text)
                result, _ = self.decode(recognizer)
                self.assertEqual(result, '')
                self.assertEqual(recognizer.calls, 1)

    def test_lowest_nonzero_pcm_volume_is_not_discarded(self):
        samples = np.zeros(16000, dtype=np.int16)
        samples[8000] = 1
        write_wav(self.path, samples)
        recognizer = Recognizer('<|zh|>听得见。')
        text, _ = self.decode(recognizer)
        self.assertEqual(text, '听得见。')
        self.assertEqual(recognizer.calls, 1)
        self.assertEqual(float(recognizer.waveforms[0][1].max()), 1 / 32768)

    def test_chunk_boundaries_preserve_every_frame_once_in_order(self):
        for frames in (1, 15999, 240000, 399999, 400000, 400001,
                       640000, 800001, 1600000, 1920001):
            with self.subTest(frames=frames):
                samples = (np.arange(frames, dtype=np.int32) % 32768).astype(np.int16)
                write_wav(self.path, samples)
                with wave.open(str(self.path), 'rb') as audio:
                    chunks = list(runner.chunks(audio))
                actual = np.concatenate([data for _, data in chunks])
                np.testing.assert_array_equal(actual, samples.astype(np.float32) / 32768)
                offset = 0
                for start, data in chunks:
                    self.assertEqual(start, offset / 16000)
                    offset += len(data)
                self.assertEqual(offset, frames)


class ErrorProtocolTests(unittest.TestCase):
    SECRET = 'PRIVATE-TRANSCRIPT-and-D:\\private\\recording.m4a'

    def setUp(self):
        runner.CANCELLED.clear()
        runner.ERROR_PHASE = 'runtime'
        self.addCleanup(runner.CANCELLED.clear)
        folder = tempfile.TemporaryDirectory(prefix='sensevoice-protocol-test-')
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.source = self.root / 'input.audio'
        self.source.write_bytes(b'placeholder')
        self.output = self.root / 'result.json'
        self.recognizer = Recognizer('完整文字。')
        self.factory = mock.Mock(return_value=self.recognizer)
        fake_sherpa = types.SimpleNamespace(OfflineRecognizer=types.SimpleNamespace(
            from_sense_voice=self.factory))
        self.args = ['sensevoice_runner.py', '--root', str(self.root), '--output', str(self.output),
                     '--input', str(self.source)]
        self.start_patch(mock.patch.object(sys, 'argv', self.args))
        self.start_patch(mock.patch.dict(sys.modules, {'sherpa_onnx': fake_sherpa}))
        self.start_patch(mock.patch.object(runner, 'local_path', side_effect=lambda path: Path(path).resolve(strict=True)))
        self.start_patch(mock.patch.object(runner, 'ffmpeg_executable', return_value=self.root / 'ffmpeg.exe'))
        self.start_patch(mock.patch.object(runner.threading, 'Thread'))
        self.converter = self.start_patch(mock.patch.object(
            runner, 'convert', side_effect=lambda source, target: write_wav(target, [1] * 16000)))

    def start_patch(self, patch):
        value = patch.start()
        self.addCleanup(patch.stop)
        return value

    def invoke(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = runner.entrypoint()
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertNotIn(self.SECRET, stdout.getvalue())
        self.assertNotIn(self.SECRET, stderr.getvalue())
        self.assertNotIn(str(self.root), stdout.getvalue())
        self.assertNotIn(str(self.root), stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())
        return code, events, stderr.getvalue()

    def assert_error(self, expected):
        code, events, stderr = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(events[-1], {'event': 'error', 'code': expected})
        self.assertEqual(stderr, 'SenseVoice local operation failed.\n')

    def test_missing_dependency_is_safe_and_specific(self):
        with mock.patch.dict(sys.modules, {'sherpa_onnx': None}):
            self.assert_error('dependencies')

    def test_missing_ffmpeg_is_dependency_error(self):
        with mock.patch.object(runner, 'ffmpeg_executable', side_effect=RuntimeError(self.SECRET)):
            self.assert_error('dependencies')

    def test_model_load_failure_has_specific_code(self):
        self.factory.side_effect = RuntimeError(self.SECRET)
        self.assert_error('model')

    def test_conversion_failure_has_specific_code(self):
        self.converter.side_effect = RuntimeError(self.SECRET)
        self.assert_error('audio_decode')

    def test_invalid_decoded_wav_is_audio_error(self):
        self.converter.side_effect = lambda source, target: target.write_bytes(b'not a wave')
        self.assert_error('audio_decode')

    def test_model_decode_failure_is_recognition_error(self):
        self.recognizer.decode_stream = mock.Mock(side_effect=RuntimeError(self.SECRET))
        self.assert_error('recognition')

    def test_result_write_failure_is_output_error(self):
        with mock.patch.object(runner.json, 'dump', side_effect=OSError(self.SECRET)):
            self.assert_error('output')

    def test_existing_result_is_never_overwritten(self):
        self.output.write_text('preserve me', encoding='utf-8')
        self.assert_error('output')
        self.assertEqual(self.output.read_text(encoding='utf-8'), 'preserve me')

    def test_private_invalid_arguments_are_not_echoed(self):
        with mock.patch.object(sys, 'argv', [*self.args, '--unexpected', self.SECRET]):
            self.assert_error('runtime')

    def test_unknown_error_phase_falls_back_to_fixed_runtime_code(self):
        runner.ERROR_PHASE = self.SECRET
        with mock.patch.object(runner, 'main', side_effect=ValueError(self.SECRET)):
            self.assert_error('runtime')

    def test_cancellation_uses_runtime_code_without_private_exception(self):
        runner.CANCELLED.set()
        with mock.patch.object(runner, 'main', side_effect=ValueError(self.SECRET)):
            self.assert_error('runtime')

    def test_success_has_no_error_event_and_writes_complete_result(self):
        code, events, stderr = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')
        self.assertFalse(any(event['event'] == 'error' for event in events))
        result = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual(result, {'ok': True, 'model': runner.MODEL,
                                  'device': 'cpu', 'text': '完整文字。'})


if __name__ == '__main__':
    unittest.main()
