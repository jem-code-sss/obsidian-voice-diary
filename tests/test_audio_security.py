"""Real offline FFmpeg regressions using generated tones, never a speech model.

Install the documented imageio-ffmpeg dependency to run these tests. All media
and attack fixtures are created in an owned workspace temporary directory.
"""
import importlib.util
import math
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
import wave
from xml.sax.saxutils import escape

RUNNER = Path(__file__).resolve().parents[1] / 'runtime' / 'sensevoice_runner.py'
SPEC = importlib.util.spec_from_file_location('sensevoice_audio_security', RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def tone(path):
    with wave.open(str(path), 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(b''.join(struct.pack('<h', round(4096 * math.sin(i * 2 * math.pi * 440 / 16000)))
                                  for i in range(6400)))


def dash(reference):
    return ('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '
            'type="static" mediaPresentationDuration="PT0.4S" minBufferTime="PT0.1S" '
            'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period duration="PT0.4S">'
            '<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="256000" '
            'audioSamplingRate="16000"><BaseURL>' + escape(reference) + '</BaseURL>'
            '<SegmentBase indexRange="0-43"><Initialization range="0-43"/></SegmentBase>'
            '</Representation></AdaptationSet></Period></MPD>')


def atom(kind, contents):
    return struct.pack('>I', len(contents) + 8) + kind + contents


def external_alias(name):
    """Build an external QuickTime alias referencing an owned sibling tone."""
    filename = name.encode('ascii')
    record = (b'\0' * 10 + b'\0' * 28 + b'\0' * 12
              + bytes([len(filename)]) + filename.ljust(63, b'\0')
              + b'\0' * 16 + struct.pack('>HH', 2, 1) + b'\0' * 16)
    record += struct.pack('>HH', 2, len(filename)) + filename
    if len(filename) & 1:
        record += b'\0'
    record += struct.pack('>HH', 0xffff, 0)
    return atom(b'dref', b'\0' * 4 + struct.pack('>I', 1) + atom(b'alis', b'\0' * 4 + record))


def referenced_mp4(data, reference):
    # These are generated conventional MP4 fixtures, not a production parser.
    # Keep their sample offsets, replace their dref, and remove embedded media.
    output = bytearray()
    position = 0
    while position < len(data):
        size, kind = struct.unpack_from('>I4s', data, position)
        if size < 8 or position + size > len(data):
            raise AssertionError('Unexpected generated MP4 atom')
        contents = data[position + 8:position + size]
        if kind == b'dref':
            output.extend(external_alias(reference))
        elif kind != b'mdat':
            if kind in (b'moov', b'trak', b'mdia', b'minf', b'dinf', b'stbl'):
                contents = referenced_mp4(contents, reference)
            output.extend(atom(kind, contents))
        position += size
    return bytes(output)


class AudioSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.ffmpeg = runner.ffmpeg_executable()
        except (ImportError, RuntimeError):
            raise unittest.SkipTest('Install imageio-ffmpeg for real offline media safety tests')

    def setUp(self):
        runner.CANCELLED.clear()
        parent = RUNNER.parents[1] / '.test-output'
        parent.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='audio-security-', dir=parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.caller = self.root / 'caller-temp'
        self.caller.mkdir()
        self.external = self.root / 'outside-tone.m4a'
        tone(self.external)  # WAV content: the MPD must probe the external file.
        self.input = self.caller / 'input.audio'
        self.output = self.caller / 'decoded.wav'
        patch = mock.patch.object(runner, 'ffmpeg_executable', return_value=self.ffmpeg)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(runner.CANCELLED.clear)

    def ffmpeg_command(self, arguments):
        return subprocess.run([str(self.ffmpeg), '-hide_banner', '-loglevel', 'error', '-nostdin',
                               *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=15,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

    def assert_tone(self, path):
        with wave.open(str(path), 'rb') as audio:
            self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()), (16000, 1, 2))
            self.assertGreaterEqual(audio.getnframes(), 5000)
            self.assertTrue(any(audio.readframes(audio.getnframes())))

    def converter_debug_log(self):
        """Exercise the production argv; only redirect its normally hidden log."""
        original_popen = subprocess.Popen
        commands = []
        log = self.caller / 'converter-debug.log'
        with log.open('wb') as stderr:
            def spawn(arguments, **options):
                commands.append(list(arguments))
                arguments = list(arguments)
                arguments[arguments.index('-loglevel') + 1] = 'debug'
                options['stderr'] = stderr
                return original_popen(arguments, **options)
            with mock.patch.object(runner.subprocess, 'Popen', side_effect=spawn):
                runner.convert(self.input, self.output)
        self.assertEqual(len(commands), 1)
        arguments = commands[0]
        position = arguments.index('-codec_whitelist')
        self.assertLess(position, arguments.index('-i'))
        self.assertEqual(arguments[position + 1], runner.AUDIO_CODECS)
        self.assert_tone(self.output)
        return log.read_text(encoding='utf-8', errors='replace')

    def test_same_dash_attack_succeeds_with_old_arguments_but_production_convert_rejects_it(self):
        for reference in (self.external.as_posix(), 'file:' + self.external.as_posix(), '../outside-tone.m4a'):
            with self.subTest(reference=reference):
                self.input.write_text(dash(reference), encoding='utf-8')
                # Reproduce the old vulnerability against synthetic audio only.
                control = self.caller / 'old-converter.wav'
                old = self.ffmpeg_command(['-protocol_whitelist', 'file,pipe', '-y', '-i', str(self.input),
                                          '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(control)])
                self.assertEqual(old.returncode, 0, old.stderr.decode(errors='replace'))
                self.assert_tone(control)
                with self.assertRaisesRegex(RuntimeError, 'Cannot decode'):
                    runner.convert(self.input, self.output)
                self.assertFalse(self.output.exists())

    def test_playlists_disguised_as_audio_are_rejected(self):
        fixtures = {
            'dash': dash('../outside-tone.m4a'),
            'hls': '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.4,\n../outside-tone.m4a\n#EXT-X-ENDLIST\n',
            'concat': "ffconcat version 1.0\nfile '../outside-tone.m4a'\n",
        }
        for name, data in fixtures.items():
            with self.subTest(format=name):
                self.input.write_text(data, encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'Cannot decode'):
                    runner.convert(self.input, self.output)
                self.assertFalse(self.output.exists())

    def test_normal_self_contained_formats_work_with_the_fixed_input_audio_name(self):
        formats = {
            'wav': ['-c:a', 'pcm_s16le'],
            'm4a': ['-c:a', 'aac'],
            'mp4': ['-c:a', 'aac'],
            '3gp': ['-c:a', 'aac'],
            'mp3': ['-c:a', 'libmp3lame'],
            'webm': ['-c:a', 'libopus'],
            'ogg': ['-c:a', 'libvorbis'],
            'oga': ['-c:a', 'libvorbis'],
            'opus': ['-c:a', 'libopus'],
            'flac': ['-c:a', 'flac'],
            'aac': ['-c:a', 'aac'],
        }
        for extension, options in formats.items():
            with self.subTest(format=extension):
                encoded = self.root / ('tone.' + extension)
                result = self.ffmpeg_command(['-y', '-i', str(self.external), *options, str(encoded)])
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                self.input.write_bytes(encoded.read_bytes())
                runner.convert(self.input, self.output)
                self.assert_tone(self.output)
                self.output.unlink()

    def test_codec_whitelist_contains_only_audio_decoders_from_the_local_binary(self):
        result = self.ffmpeg_command(['-decoders'])
        self.assertEqual(result.returncode, 0)
        decoders = dict((name, kind) for kind, name in re.findall(
            r'^ ([VAS])[A-Z.]{5}\s+([a-z0-9_][a-z0-9_.-]*)\s',
            result.stdout.decode(errors='replace'), flags=re.MULTILINE))
        allowed = set(runner.AUDIO_CODECS.split(','))
        self.assertGreater(len(allowed), 20)
        self.assertTrue(allowed.issubset(decoders), allowed - decoders.keys())
        self.assertTrue(all(decoders[name] == 'A' for name in allowed))
        self.assertTrue(allowed.isdisjoint(('exr', 'jpeg2000', 'mjpeg', 'png', 'h264', 'hevc')))

    def test_common_wav_pcm_variants_and_alac_are_not_lost_by_the_decoder_restriction(self):
        variants = [('wav', codec) for codec in (
            'pcm_u8', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le',
            'pcm_alaw', 'pcm_mulaw', 'adpcm_ima_wav', 'adpcm_ms')]
        variants.append(('m4a', 'alac'))
        for extension, codec in variants:
            with self.subTest(codec=codec):
                encoded = self.root / ('tone-' + codec + '.' + extension)
                result = self.ffmpeg_command(['-y', '-i', str(self.external), '-c:a', codec, str(encoded)])
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                self.input.write_bytes(encoded.read_bytes())
                runner.convert(self.input, self.output)
                self.assert_tone(self.output)
                self.output.unlink()

    def test_mp3_cover_art_is_blocked_before_decoder_initialization_while_audio_remains_usable(self):
        cover = self.root / 'cover.jpg'
        result = self.ffmpeg_command(['-y', '-f', 'lavfi', '-i', 'color=red:s=16x16:d=1',
                                     '-frames:v', '1', str(cover)])
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        encoded = self.root / 'covered.mp3'
        result = self.ffmpeg_command(['-y', '-i', str(self.external), '-i', str(cover),
                                     '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame',
                                     '-c:v', 'copy', '-id3v2_version', '3',
                                     '-disposition:v', 'attached_pic', str(encoded)])
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.input.write_bytes(encoded.read_bytes())
        old = self.ffmpeg_command(['-loglevel', 'debug', '-protocol_whitelist', 'file,pipe',
                                  '-format_whitelist', runner.AUDIO_FORMATS, '-y', '-i', str(self.input),
                                  '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
                                  str(self.caller / 'old-cover.wav')])
        self.assertEqual(old.returncode, 0, old.stderr.decode(errors='replace'))
        self.assertIn('marker=d8', old.stderr.decode(errors='replace'))
        log = self.converter_debug_log()
        self.assertIn('Codec (mjpeg) not on whitelist', log)
        self.assertNotIn('marker=d8', log)
        self.assertNotIn('decode frame unused', log)

    def test_video_tracks_in_allowed_containers_cannot_open_video_decoders_during_probe(self):
        for codec, container, extension in (('exr', 'matroska', 'webm'),
                                             ('jpeg2000', 'mov', 'm4a')):
            with self.subTest(video_codec=codec):
                encoded = self.root / ('video-and-audio-' + codec + '.' + extension)
                result = self.ffmpeg_command(['-y', '-f', 'lavfi', '-i', 'color=red:s=16x16:r=1:d=1',
                                             '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
                                             '-c:v', codec, '-c:a', 'aac',
                                             '-shortest', '-f', container, str(encoded)])
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                self.input.write_bytes(encoded.read_bytes())
                if codec == 'exr':
                    # A normal generated frame, not a vulnerability payload.
                    # Even input-side discard is applied after stream probing.
                    old = self.ffmpeg_command(['-loglevel', 'debug', '-protocol_whitelist', 'file,pipe',
                                              '-format_whitelist', runner.AUDIO_FORMATS,
                                              '-discard:v', 'all', '-y', '-i', str(self.input), '-vn',
                                              '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
                                              str(self.caller / 'old-exr.wav')])
                    self.assertEqual(old.returncode, 0, old.stderr.decode(errors='replace'))
                    self.assertIn('line order:', old.stderr.decode(errors='replace'))
                log = self.converter_debug_log()
                self.assertIn('Codec (' + codec + ') not on whitelist', log)
                self.assertNotIn('line order:', log)
                self.output.unlink()

    def test_mp4_external_tracks_are_disabled_in_the_actual_converter(self):
        external = self.root / 'external.m4a'
        result = self.ffmpeg_command(['-y', '-i', str(self.external), '-c:a', 'aac', str(external)])
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.input.write_bytes(referenced_mp4(external.read_bytes(), external.name))
        # A positive control proves the fixture has a valid, usable external
        # track. Only this synthetic-media control deliberately enables drefs.
        old = self.caller / 'enabled-drefs.wav'
        result = self.ffmpeg_command(['-enable_drefs', '1', '-y', '-i', self.input.as_posix(),
                                     '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(old)])
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assert_tone(old)
        runner.convert(self.input.as_posix(), self.output)
        # FFmpeg may report success after skipping the external-only track, but
        # it must produce no samples. The runner rejects this before recognition.
        with wave.open(str(self.output), 'rb') as audio:
            self.assertEqual(audio.getnframes(), 0)
        with self.assertRaisesRegex(ValueError, 'Empty recording'):
            runner.decode(None, self.output)


if __name__ == '__main__':
    unittest.main()
