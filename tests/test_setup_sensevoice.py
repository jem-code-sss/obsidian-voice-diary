"""Offline installer tests: tiny generated archives, fake HTTP, no downloads."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest import mock
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / 'runtime/setup_sensevoice.py'
SPEC = importlib.util.spec_from_file_location('setup_sensevoice_tests', SCRIPT)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class Response(io.BytesIO):
    def __init__(self, data=b'archive', length='7', url=setup.MODEL_URL):
        super().__init__(data)
        self.headers = {} if length is None else {'Content-Length': length}
        self.url = url

    def geturl(self):
        return self.url


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sensevoice-setup-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.data = {name: ('test ' + name).encode() for name in setup.FILES}
        pins = {name: (len(value), hashlib.sha256(value).hexdigest()) for name, value in self.data.items()}
        patch = mock.patch.object(setup, 'FILES', pins)
        patch.start()
        self.addCleanup(patch.stop)
        self.archive = self.root / 'archive.tar.bz2'
        self.destination = self.root / 'candidate'

    def archive_file(self, names=None, extra=()):
        with tarfile.open(self.archive, 'w:bz2') as target:
            for name, value in self.data.items():
                entry = next(key for key, output in setup.ARCHIVE_PATHS.items() if output == name)
                if names is not None and name not in names:
                    continue
                member = tarfile.TarInfo(entry)
                member.size = len(value)
                target.addfile(member, io.BytesIO(value))
            for member, data in extra:
                target.addfile(member, io.BytesIO(data) if data else None)

    def make_model(self, folder):
        folder.mkdir()
        for name, data in self.data.items():
            (folder / name).write_bytes(data)
        return folder

    def capture(self, function, *args, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = function(*args, **kwargs)
        return result, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_extracts_only_exact_four_files_and_preserves_license(self):
        member = tarfile.TarInfo(setup.RELEASE + '/export-onnx.py')
        member.size = len(b'raise RuntimeError("must not run")')
        self.archive_file(extra=[(member, b'raise RuntimeError("must not run")')])
        setup.unpack(self.archive, self.destination)
        self.assertEqual({p.name for p in self.destination.iterdir()}, set(self.data))
        self.assertEqual((self.destination / 'LICENSE').read_bytes(), self.data['LICENSE'])
        self.assertTrue(setup.verified(self.destination))

    def test_missing_required_file_fails(self):
        self.archive_file(names=set(self.data) - {'tokens.txt'})
        with self.assertRaises(ValueError):
            setup.unpack(self.archive, self.destination)

    def test_matching_size_with_wrong_sha256_fails(self):
        self.data['tokens.txt'] = b'x' * len(self.data['tokens.txt'])
        self.archive_file()
        with self.assertRaisesRegex(ValueError, 'integrity'):
            setup.unpack(self.archive, self.destination)

    def test_traversal_absolute_drive_backslash_and_wrong_root_rejected(self):
        for number, name in enumerate(('../outside', '/absolute', 'C:/drive',
                                       setup.RELEASE + '/../../outside', setup.RELEASE + '\\tokens.txt', 'other/tokens.txt')):
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.size = 1
                self.archive_file(extra=[(member, b'x')])
                with self.assertRaises(ValueError):
                    setup.unpack(self.archive, self.root / f'candidate-{number}')
                self.assertFalse((self.root.parent / 'outside').exists())

    def test_symlinks_hardlinks_and_special_entries_rejected(self):
        for number, kind in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE)):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo(setup.RELEASE + '/link')
                member.type = kind
                member.linkname = 'tokens.txt'
                self.archive_file(extra=[(member, None)])
                with self.assertRaises(ValueError):
                    setup.unpack(self.archive, self.root / f'candidate-{number}')

    def test_duplicate_required_file_rejected(self):
        member = tarfile.TarInfo(setup.RELEASE + '/tokens.txt')
        member.size = len(self.data['tokens.txt'])
        self.archive_file(extra=[(member, self.data['tokens.txt'])])
        with self.assertRaises(ValueError):
            setup.unpack(self.archive, self.destination)

    def test_member_size_mismatch_rejected_before_copy(self):
        self.data['tokens.txt'] += b'extra'
        self.archive_file()
        with self.assertRaisesRegex(ValueError, 'required archive member'):
            setup.unpack(self.archive, self.destination)

    def test_archive_member_limit_stops_unbounded_headers(self):
        entries = [(tarfile.TarInfo(f'{setup.RELEASE}/ignored-{i}'), None) for i in range(260)]
        self.archive_file(extra=entries)
        with self.assertRaisesRegex(ValueError, 'entry count'):
            setup.unpack(self.archive, self.destination)

    def test_redirects_restricted_to_official_https_hosts(self):
        for value in ('http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x',
                      'https://user:password@github.com/x', 'https://github.com:444/x'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                setup.allowed_url(value)
        self.assertEqual(setup.allowed_url('https://release-assets.githubusercontent.com/x'),
                         'https://release-assets.githubusercontent.com/x')

    def test_download_streams_and_reports_only_safe_progress(self):
        response = Response()
        opener = types.SimpleNamespace(open=mock.Mock(return_value=response))
        _, events = self.capture(setup.download, self.archive, opener)
        self.assertEqual(self.archive.read_bytes(), b'archive')
        self.assertEqual(events, [{'event': 'progress', 'stage': 'model', 'pct': 99}])
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, setup.MODEL_URL)
        self.assertNotIn('Authorization', request.headers)

    def test_length_mismatch_and_oversize_leave_no_partial_download(self):
        for response in (Response(length='8'), Response(length=str(setup.MAX_DOWNLOAD + 1)),
                         Response(data=b'', length=None), Response(url='https://evil.example/private')):
            with self.subTest(response=response):
                with self.assertRaises(ValueError):
                    self.capture(setup.download, self.archive, types.SimpleNamespace(open=lambda *a, **k: response))
                self.assertFalse(self.archive.exists())

    def test_download_retries_transient_network_errors(self):
        opener = types.SimpleNamespace(open=mock.Mock(side_effect=[urllib.error.URLError('private proxy'), Response()]))
        sleeper = mock.Mock()
        self.capture(setup.download, self.archive, opener, sleeper)
        self.assertEqual(opener.open.call_count, 2)
        sleeper.assert_called_once_with(1)
        self.assertEqual(self.archive.read_bytes(), b'archive')

    def test_forbidden_http_error_is_not_retried(self):
        error = urllib.error.HTTPError(setup.MODEL_URL, 403, 'forbidden', None, None)
        opener = types.SimpleNamespace(open=mock.Mock(side_effect=error))
        with self.assertRaises(urllib.error.HTTPError):
            setup.download(self.archive, opener, mock.Mock())
        self.assertEqual(opener.open.call_count, 1)
        self.assertFalse(self.archive.exists())

    def test_complete_existing_model_uses_no_network_and_keeps_files(self):
        target = self.make_model(self.root / 'models')
        with mock.patch.object(setup, 'download') as download, mock.patch.object(setup, 'probe') as probe:
            _, events = self.capture(setup.setup, self.root)
        download.assert_not_called()
        probe.assert_called_once_with(target)
        self.assertTrue(setup.verified(target))
        self.assertEqual(events, [{'event': 'progress', 'stage': 'verify'}])

    def test_existing_model_probe_failure_keeps_all_files_without_network(self):
        target = self.make_model(self.root / 'models')
        with mock.patch.object(setup, 'download') as download, mock.patch.object(setup, 'probe', side_effect=RuntimeError()):
            with self.assertRaises(RuntimeError):
                self.capture(setup.setup, self.root)
        download.assert_not_called()
        self.assertTrue(setup.verified(target))

    def test_unverified_candidate_is_never_published_and_temporary_is_removed(self):
        self.archive_file()
        def download(path):
            path.write_bytes(self.archive.read_bytes())
        with mock.patch.object(setup, 'download', side_effect=download), mock.patch.object(setup, 'probe', side_effect=RuntimeError()):
            with self.assertRaises(RuntimeError):
                self.capture(setup.setup, self.root)
        self.assertFalse((self.root / 'models').exists())
        self.assertFalse(list(self.root.glob('.setup-model-*')))

    def test_retry_removes_only_marked_owned_downloads_even_with_valid_model(self):
        self.make_model(self.root / 'models')
        stale = self.root / '.setup-model-a1b2c3d4'
        stale.mkdir()
        (stale / '.owned-download').write_bytes(b'voice-diary-sensevoice-download-v1')
        (stale / 'model.tar.bz2').write_bytes(b'interrupted download')
        unrelated = self.root / '.setup-model-e5f6g7h8'
        unrelated.mkdir()
        (unrelated / 'user-file').write_text('preserve', encoding='utf-8')
        with mock.patch.object(setup, 'download') as download, mock.patch.object(setup, 'probe'):
            self.capture(setup.setup, self.root)
        download.assert_not_called()
        self.assertFalse(stale.exists())
        self.assertTrue((unrelated / 'user-file').exists())

    def test_success_probes_before_publish_and_preserves_unknown_user_files(self):
        self.archive_file()
        target = self.root / 'models'
        target.mkdir()
        (target / 'user-file.txt').write_text('preserve', encoding='utf-8')
        (target / 'tokens.txt').write_bytes(b'old incomplete')
        def download(path):
            path.write_bytes(self.archive.read_bytes())
        def probe(folder):
            self.assertTrue(setup.verified(folder))
            self.assertEqual((target / 'tokens.txt').read_bytes(), b'old incomplete')
        with mock.patch.object(setup, 'download', side_effect=download), mock.patch.object(setup, 'probe', side_effect=probe):
            self.capture(setup.setup, self.root)
        self.assertTrue(setup.verified(target))
        self.assertEqual((target / 'user-file.txt').read_text(), 'preserve')
        self.assertFalse(list(self.root.glob('.setup-model-*')))

    def test_publication_failure_rolls_back_exact_existing_files(self):
        candidate = self.make_model(self.destination)
        target = self.root / 'models'
        target.mkdir()
        for name in self.data:
            (target / name).write_bytes(b'old ' + name.encode())
        old = {p.name: p.read_bytes() for p in target.iterdir()}
        original = setup.os.replace
        count = [0]
        def replace(source, destination):
            count[0] += 1
            if count[0] == 4:
                raise OSError('simulated disk failure')
            return original(source, destination)
        with mock.patch.object(setup.os, 'replace', side_effect=replace):
            with self.assertRaises(OSError):
                setup.publish(candidate, target, self.root / 'previous')
        self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, old)

    def test_windows_reparse_attributes_are_rejected(self):
        info = types.SimpleNamespace(st_mode=0o40755, st_file_attributes=0x400)
        with mock.patch.object(Path, 'lstat', return_value=info), self.assertRaises(ValueError):
            setup.no_links(self.root)

    def test_entrypoint_does_not_print_private_exception_paths(self):
        with mock.patch.object(setup, 'main', side_effect=RuntimeError('private path and token')), \
                mock.patch.object(setup, 'ERROR_PHASE', 'download'):
            result, events = self.capture(setup.entrypoint)
        self.assertEqual(result, 1)
        self.assertEqual(events, [{'event': 'error', 'code': 'download'}])


if __name__ == '__main__':
    unittest.main()
