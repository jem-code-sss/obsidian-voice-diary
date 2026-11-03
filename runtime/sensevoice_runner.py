"""One-shot offline SenseVoice worker; stdout contains safe protocol events only."""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import unicodedata
import wave

MODEL = 'SenseVoiceSmall INT8'
LANGUAGES = ('auto', 'zh', 'en', 'ja', 'ko', 'yue')
CANCELLED = threading.Event()
PROCESS_LOCK = threading.Lock()
CONVERTER = None
ERROR_CODES = frozenset(('dependencies', 'model', 'audio_decode', 'recognition', 'output', 'runtime'))
ERROR_PHASE = 'runtime'


def no_network(*args, **kwargs):
    raise RuntimeError('Offline operation only')


socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True


def progress(event, **values):
    print(json.dumps(dict(event=event, **values)), flush=True)


def check_cancelled():
    if CANCELLED.is_set():
        raise RuntimeError('Cancelled')


def watch_cancel():
    # The parent owns stdin. EOF also means the caller has gone away.
    try:
        # Raw fd reads avoid a daemon holding Python's buffered-stdin lock at exit.
        command = bytearray()
        while len(command) < 256 and b'\n' not in command:
            data = os.read(sys.stdin.fileno(), 256 - len(command))
            if not data:
                break
            command.extend(data)
        line = bytes(command).decode('ascii', errors='ignore')
    except Exception:
        line = ''
    if line.strip() == 'cancel' or not line:
        CANCELLED.set()
        with PROCESS_LOCK:
            if CONVERTER is not None and CONVERTER.poll() is None:
                try:
                    CONVERTER.terminate()
                except OSError:
                    pass


def local_path(value):
    path = Path(value)
    if not path.is_absolute() or not re.match(r'^[A-Za-z]:[\\/]', str(path)):
        raise ValueError('A local absolute path is required')
    resolved = path.resolve(strict=True)
    if not re.match(r'^[A-Za-z]:[\\/]', str(resolved)):
        raise ValueError('Network paths are not supported')
    return resolved


def chunks(audio):
    """Use the installed app's contiguous 15-25s quiet-boundary strategy."""
    import numpy as np
    rate = audio.getframerate()
    total = audio.getnframes()
    position = 0
    while position < total:
        check_cancelled()
        audio.setpos(position)
        data = np.frombuffer(audio.readframes(25 * rate), dtype='<i2').astype(np.float32) / 32768
        if len(data) == 25 * rate and position + len(data) < total:
            step = rate // 10
            quiet = min(range(15 * rate, len(data) - step + 1, step),
                        key=lambda i: float(np.mean(data[i:i + step] ** 2)))
            data = data[:quiet + step // 2]
        if not len(data):
            raise ValueError('Invalid audio frame count')
        yield position / rate, data
        position += len(data)


def decode(recognizer, path):
    global ERROR_PHASE
    parts = []
    ERROR_PHASE = 'audio_decode'
    with wave.open(str(path), 'rb') as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError('Unsupported decoded PCM')
        duration = audio.getnframes() / 16000
        if not duration:
            raise ValueError('Empty recording')
        for start, samples in chunks(audio):
            check_cancelled()
            # SenseVoice can invent words even from all-zero PCM. Only skip
            # exact digital silence: a volume threshold could discard soft speech.
            if samples.any():
                ERROR_PHASE = 'recognition'
                stream = recognizer.create_stream()
                stream.accept_waveform(16000, samples)
                recognizer.decode_stream(stream)
                check_cancelled()
                text = re.sub(r'<\|.*?\|>', '', stream.result.text).strip()
                if any(not char.isspace() and not unicodedata.category(char).startswith('P')
                       for char in text):
                    parts.append(text)
            ERROR_PHASE = 'audio_decode'
            progress('progress', pct=round(min(100, (start + len(samples) / 16000) / duration * 100), 1))
    check_cancelled()
    return '\n'.join(parts)


def ffmpeg_executable():
    import imageio_ffmpeg
    # Resolve the already-installed executable directly; never invoke a downloader
    # or an IMAGEIO_FFMPEG_EXE override from the caller's environment.
    binaries = Path(imageio_ffmpeg.__file__).resolve().parent / 'binaries'
    candidates = sorted(binaries.glob('ffmpeg*.exe'))
    if not candidates:
        raise RuntimeError('Local ffmpeg is missing')
    return candidates[0]


def convert(source, target):
    global CONVERTER
    executable = ffmpeg_executable()
    check_cancelled()
    with PROCESS_LOCK:
        check_cancelled()
        CONVERTER = subprocess.Popen([
            str(executable), '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-protocol_whitelist', 'file,pipe', '-y', '-i', str(source), '-vn',
            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(target),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        process = CONVERTER
    try:
        code = process.wait(timeout=120)
        check_cancelled()
        if code:
            raise RuntimeError('Cannot decode this recording')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        with PROCESS_LOCK:
            CONVERTER = None


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse otherwise echoes caller-provided arguments to stderr.
        raise ValueError('Invalid runner arguments')


def main():
    global ERROR_PHASE
    ERROR_PHASE = 'runtime'
    parser = SafeArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--language', choices=LANGUAGES, default='zh')
    parser.add_argument('--output', required=True)
    parser.add_argument('--debug-stack', action='store_true', help=argparse.SUPPRESS)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--probe', action='store_true')
    action.add_argument('--input')
    args = parser.parse_args()
    if args.debug_stack:
        import faulthandler
        faulthandler.dump_traceback_later(10, repeat=True)
    ERROR_PHASE = 'dependencies'
    root = local_path(args.root)
    ERROR_PHASE = 'output'
    output_parent = local_path(str(Path(args.output).parent))
    output = output_parent / Path(args.output).name
    if output.exists() or output.name != 'result.json':
        raise ValueError('Result path is unavailable')
    # Load native extensions before a Windows CRT stdin read is blocked on a
    # second thread. NumPy initialization can otherwise wait on that CRT lock.
    ERROR_PHASE = 'dependencies'
    import numpy  # noqa: F401; chunks() uses the initialized module.
    import sherpa_onnx
    ffmpeg_executable()
    ERROR_PHASE = 'runtime'
    threading.Thread(target=watch_cancel, daemon=True).start()
    ERROR_PHASE = 'model'
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(root / 'models/model.int8.onnx'), tokens=str(root / 'models/tokens.txt'),
        num_threads=min(4, os.cpu_count() or 1), use_itn=True,
        language='zh' if args.probe else args.language, provider='cpu', debug=False)
    check_cancelled()
    progress('ready')
    if args.probe:
        # The bundled official sample exercises model loading and decoding.
        sample = local_path(str(root / 'models/zh.wav'))
        text = decode(recognizer, sample)
        if not text.strip():
            ERROR_PHASE = 'recognition'
            raise RuntimeError('Model probe did not produce speech')
        result = dict(ok=True, model=MODEL, device='cpu')
    else:
        ERROR_PHASE = 'audio_decode'
        source = local_path(args.input)
        if source.parent != output_parent:
            raise ValueError('Recording must use the caller temporary directory')
        converted = output_parent / 'decoded.wav'
        convert(source, converted)
        result = dict(ok=True, model=MODEL, device='cpu', text=decode(recognizer, converted))
    check_cancelled()
    # Only a complete result is visible to the parent. No partial transcript files.
    ERROR_PHASE = 'output'
    with output.open('x', encoding='utf-8') as target:
        json.dump(result, target, ensure_ascii=False)


def entrypoint():
    try:
        main()
        return 0
    except Exception:
        # Never print private source paths, audio content, or library tracebacks.
        code = ERROR_PHASE if ERROR_PHASE in ERROR_CODES and not CANCELLED.is_set() else 'runtime'
        progress('error', code=code)
        print('SenseVoice local operation failed.', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(entrypoint())
