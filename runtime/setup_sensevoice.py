"""Download the official sherpa-onnx SenseVoice export on explicit user action.

Source model: https://github.com/QwenAudio/SenseVoice (formerly FunAudioLLM).
ONNX export: https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
Weights have their own upstream license, independent of the plugin's license:
https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
The release's LICENSE is preserved unchanged. No scripts in the tarball run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave

RELEASE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
MODEL_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/'
             f'asr-models/{RELEASE}.tar.bz2')
MODEL_LICENSE_URL = 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE'
DOWNLOAD_HOSTS = frozenset(('github.com', 'release-assets.githubusercontent.com',
                            'objects.githubusercontent.com'))
# Full SHA-256 and sizes of the fixed official release, verified against the
# previously tested official download. These are local release pins, not a
# claim that upstream published a signed checksum manifest.
FILES = {
    'model.int8.onnx': (239233841, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'),
    'tokens.txt': (315894, 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'),
    'zh.wav': (178988, 'b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373'),
    'LICENSE': (71, '221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17'),
}
ARCHIVE_PATHS = {f'{RELEASE}/{name if name != "zh.wav" else "test_wavs/zh.wav"}': name
                 for name in FILES}
MAX_DOWNLOAD = 320 * 1024 * 1024
ERROR_CODES = frozenset(('root', 'download', 'model', 'runtime'))
ERROR_PHASE = 'runtime'


def event(kind, **values):
    print(json.dumps(dict(event=kind, **values)), flush=True)


def regular(path):
    try:
        info = path.lstat()
        return stat.S_ISREG(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400
    except OSError:
        return False


def no_links(path):
    """Reject both symbolic links and Windows junction/reparse point ancestors."""
    path = Path(path).absolute()
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Linked paths are unsupported')
    return path


def root_path(value):
    path = Path(value)
    if not path.is_absolute() or (os.name == 'nt' and not re.match(r'^[A-Za-z]:[\\/]', str(path))):
        raise ValueError('A local absolute root is required')
    path = no_links(path).resolve(strict=True)
    if not path.is_dir() or path == Path(path.anchor):
        raise ValueError('Invalid setup root')
    return path


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for data in iter(lambda: source.read(1024 * 1024), b''):
            value.update(data)
    return value.hexdigest()


def verified(folder):
    try:
        no_links(folder)
        return folder.is_dir() and all(
            regular(folder / name) and (folder / name).stat().st_size == size
            and digest(folder / name) == checksum
            for name, (size, checksum) in FILES.items())
    except (OSError, ValueError):
        return False


def allowed_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in DOWNLOAD_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('Unexpected model download origin')
    return url


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        allowed_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download(target, opener=None, sleeper=time.sleep):
    opener = opener or urllib.request.build_opener(OfficialRedirect())
    request = urllib.request.Request(allowed_url(MODEL_URL), headers={'User-Agent': 'VoiceDiaryUnified-Setup'})
    for attempt in range(3):
        try:
            with opener.open(request, timeout=45) as response, target.open('xb') as output:
                allowed_url(response.geturl())
                length = response.headers.get('Content-Length')
                expected = int(length) if length is not None else None
                if expected is not None and not 0 < expected <= MAX_DOWNLOAD:
                    raise ValueError('Unexpected archive size')
                total, reported = 0, -1
                while True:
                    data = response.read(1024 * 1024)
                    if not data:
                        break
                    total += len(data)
                    if total > MAX_DOWNLOAD:
                        raise ValueError('Archive exceeds size limit')
                    output.write(data)
                    pct = min(99, total * 100 // expected) if expected else 0
                    if pct // 5 > reported:
                        reported = pct // 5
                        event('progress', stage='model', pct=pct)
                if not total or (expected is not None and total != expected):
                    raise ValueError('Incomplete archive')
            return
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            target.unlink(missing_ok=True)
            if (attempt == 2 or isinstance(error, urllib.error.HTTPError)
                    and error.code not in (408, 429, 500, 502, 503, 504)):
                raise
            sleeper(attempt + 1)
        except Exception:
            target.unlink(missing_ok=True)
            raise


def unpack(archive, destination):
    """Copy only four exact regular-file members, never tarfile.extract()."""
    destination.mkdir()
    found = set()
    total_size = 0
    with tarfile.open(archive, 'r:bz2') as bundle:
        for count, member in enumerate(bundle):
            if count >= 256:
                raise ValueError('Unexpected archive entry count')
            name = member.name
            parts = PurePosixPath(name).parts
            if (not parts or '\\' in name or ':' in name or name.startswith('/')
                    or '..' in parts or parts[0] != RELEASE):
                raise ValueError('Unsafe archive path')
            if not (member.isfile() or member.isdir()) or getattr(member, 'sparse', None):
                raise ValueError('Only ordinary archive files are allowed')
            total_size += member.size
            if member.size < 0 or member.size > MAX_DOWNLOAD or total_size > 600 * 1024 * 1024:
                raise ValueError('Unexpected uncompressed archive size')
            output_name = ARCHIVE_PATHS.get(name)
            if output_name is None:
                continue
            if output_name in found or not member.isfile() or member.size != FILES[output_name][0]:
                raise ValueError('Unexpected required archive member')
            found.add(output_name)
            source = bundle.extractfile(member)
            if source is None:
                raise ValueError('Missing archive data')
            with source, (destination / output_name).open('xb') as target:
                remaining = member.size
                while remaining:
                    data = source.read(min(remaining, 1024 * 1024))
                    if not data:
                        raise ValueError('Truncated archive member')
                    target.write(data)
                    remaining -= len(data)
    if found != set(FILES) or not verified(destination):
        raise ValueError('Model integrity check failed')


def probe(folder):
    import numpy as np
    import sherpa_onnx
    import imageio_ffmpeg
    # Inspect the package's local executable without consulting an environment
    # override, which the offline recording worker deliberately ignores too.
    binaries = Path(imageio_ffmpeg.__file__).resolve().parent / 'binaries'
    if not any(regular(item) for item in binaries.glob('ffmpeg*.exe')):
        raise ValueError('Bundled FFmpeg is unavailable')
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(folder / 'model.int8.onnx'), tokens=str(folder / 'tokens.txt'),
        num_threads=min(4, os.cpu_count() or 1), use_itn=True, language='zh', provider='cpu', debug=False)
    with wave.open(str(folder / 'zh.wav'), 'rb') as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
            raise ValueError('Invalid official probe audio')
        data = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, data)
    recognizer.decode_stream(stream)
    if not stream.result.text.strip():
        raise ValueError('Official sample recognition failed')


def publish(candidate, target, previous):
    """Replace only known files. Retain unrelated user files and roll back errors."""
    no_links(target)
    target.mkdir(exist_ok=True)
    previous.mkdir()
    moved, installed = [], []
    try:
        for name in FILES:
            old = target / name
            no_links(old)
            if old.exists():
                if not regular(old):
                    raise ValueError('Model destination is not a regular file')
                os.replace(old, previous / name)
                moved.append(name)
            os.replace(candidate / name, old)
            installed.append(name)
        if not verified(target):
            raise ValueError('Published model failed integrity check')
    except Exception:
        for name in reversed(installed):
            (target / name).unlink(missing_ok=True)
        for name in reversed(moved):
            os.replace(previous / name, target / name)
        raise


def setup(root):
    global ERROR_PHASE
    ERROR_PHASE = 'model'
    target = root / 'models'
    # Forced process termination cannot execute finally. Reclaim only previously
    # marked download directories after the orchestrator obtained its root lock.
    ownership = b'voice-diary-sensevoice-download-v1'
    for stale in root.glob('.setup-model-*'):
        marker = stale / '.owned-download'
        if (stale.parent == root and re.fullmatch(r'\.setup-model-[a-z0-9_]{8}', stale.name)
                and stale.is_dir() and regular(marker) and marker.stat().st_size == len(ownership)
                and marker.read_bytes() == ownership):
            no_links(stale)
            for entry in stale.rglob('*'):
                no_links(entry)
            shutil.rmtree(stale)
    if verified(target):
        event('progress', stage='verify')
        probe(target)
        return
    no_links(target)
    temporary = Path(tempfile.mkdtemp(prefix='.setup-model-', dir=root))
    (temporary / '.owned-download').write_bytes(ownership)
    try:
        ERROR_PHASE = 'download'
        event('progress', stage='model', pct=0)
        archive = temporary / 'model.tar.bz2'
        download(archive)
        ERROR_PHASE = 'model'
        candidate = temporary / 'models'
        unpack(archive, candidate)
        event('progress', stage='verify')
        probe(candidate)
        publish(candidate, target, temporary / 'previous')
    finally:
        # The only recursively removed path is the exact mkdtemp child we own.
        if (temporary.parent.resolve() == root.resolve()
                and temporary.name.startswith('.setup-model-') and not temporary.is_symlink()):
            shutil.rmtree(temporary)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid setup arguments')


def main():
    global ERROR_PHASE
    parser = SafeParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    ERROR_PHASE = 'root'
    root = root_path(args.root)
    setup(root)
    event('ready')


def entrypoint():
    try:
        main()
        return 0
    except Exception:
        event('error', code=ERROR_PHASE if ERROR_PHASE in ERROR_CODES else 'runtime')
        return 1


if __name__ == '__main__':
    sys.exit(entrypoint())
