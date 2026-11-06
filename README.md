# Voice Diary Processor

English | [简体中文](README.zh-CN.md)

Turn recordings into Obsidian notes on a Windows computer using local SenseVoice speech recognition. Optionally use a text API to clean up the transcript, or keep the entire transcription workflow offline.

Version: **0.4.0**.

Choose separate vault folders for original recordings and finished notes. Pair this desktop plugin with [Voice Diary Recorder](https://github.com/jem-code-sss/obsidian-voice-diary-recorder) to record on a phone and process the files on your computer.

Use the separate **Record tasks** entry (`录制待办`) to turn spoken plans into Markdown checkboxes. Task extraction works locally; the optional text API needs its own task opt-in as well as the global API switch. Existing diary recordings are not automatically converted into tasks.

## Requirements

| Component | Requirements |
| --- | --- |
| Desktop processing | Windows x64, Obsidian 1.8.7 or newer, and Voice Diary Processor. |
| Local speech recognition | Python 3.10–3.12, SenseVoiceSmall INT8, sherpa-onnx, NumPy, and imageio-ffmpeg. Prepare these manually as described below. FFmpeg is provided by the specified dependency; no GPU or Node.js is needed for normal use. |
| Optional phone recording | Obsidian and the separate Voice Diary Recorder plugin. The phone does not need Python, a speech model, or an API Key. Keep Obsidian in the foreground while recording. |
| Optional device synchronization | Syncthing, Obsidian Sync, or another reliable tool that synchronizes vault files. No synchronization software is needed when using only one computer. |
| Optional text cleanup | A compatible text API endpoint of your choice. It is disabled by default on new installations. |

The Processor is desktop-only. Local transcription is currently supported on Windows x64; macOS, Linux, Windows ARM, and mobile transcription have not been verified. Initial environment preparation needs internet access and sufficient disk space. After preparation, local transcription works offline.

## Install

Install **Voice Diary Processor** from its [official community directory page](https://community.obsidian.md/plugins/voice-diary-unified) or Obsidian's community plugin settings. Check the official page for the current listing and version review status.

To install manually:

1. Download `voice-diary-unified-v0.4.0.zip` from the [0.4.0 release](https://github.com/jem-code-sss/obsidian-voice-diary/releases/tag/0.4.0) and extract it.
2. Close Obsidian normally. Copy the extracted `voice-diary-unified` folder into your vault's `.obsidian/plugins/` directory. If you use a custom configuration directory, use its `plugins` directory instead.
3. Reopen Obsidian and enable **Voice Diary Processor** in community plugin settings.
4. Prepare the local recognition environment below, then apply its directory in the plugin's local recognition settings.
5. Choose the recording and note folders. Enable automatic processing under tasks and recovery, and verify the result with a short recording.

Community releases provide `main.js`, `manifest.json`, and `styles.css` as standard release assets. The Python runner is embedded in `main.js`, so a community installation does not need a separately copied `runtime/` folder. The model and Python environment must still be prepared manually. Manual ZIP assets are provided for users who install outside the directory.

### Upgrade from the earlier combined plugin

For phone and desktop use, install **Voice Diary Recorder on the phone first**. Confirm that it uses the same recording folder as the existing setup, then test saving and synchronizing a short recording. The Recorder can migrate only the old phone recording folder when it has no existing settings of its own.

Then upgrade the desktop plugin to Voice Diary Processor. It retains the plugin ID `voice-diary-unified` to preserve existing desktop settings and task records. The Processor is now desktop-only; do not depend on it for phone recording. Disable the old phone recording entry to avoid having two microphone buttons. When synchronizing `.obsidian`, verify the phone installation before replacing the combined plugin on the desktop.

Upgrading does not move existing recordings or notes, reset configured paths, or automatically rewrite finished notes. Enable automatic processing on only one computer.

## Prepare local SenseVoice recognition manually

The plugin does not install, download, or update its dependencies. Its resource buttons only open upstream resources and preparation instructions in a browser.

You can prepare a compatible environment yourself, or run the provided setup script **outside Obsidian**:

1. Download and extract `voice-diary-unified-v0.4.0-source.zip` from the [0.4.0 release](https://github.com/jem-code-sss/obsidian-voice-diary/releases/tag/0.4.0).
2. Open PowerShell in the extracted source root, where the `runtime` folder is located.
3. Review the setup files, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File runtime/setup-sensevoice.ps1
```

The script is started by you, not by the plugin. It uses the adjacent setup program and pinned requirements to obtain Python, dependencies, and the model from their official sources. It verifies the four model files with SHA-256 and runs the official short test sample. It does not read your recordings, notes, or API Key, and it does not enable the text API.

By default, the environment is placed in `%LOCALAPPDATA%\voice-diary-unified\sensevoice`, outside the vault. Leave the environment directory setting blank to use this default. The script first tries a compatible installed Python 3.10–3.12. If none is available, it installs official Python 3.12 for the current user without adding it to PATH or associating files; it may register the Python installation for local discovery.

To choose another location, pass `-Root '<local-directory>'` to the setup script, then apply that same directory in the plugin. An existing user-selected environment is not overwritten by the plugin. After preparation, click **Check and prepare** (`检查并准备`) in local recognition settings to validate the environment and load the model.

### Use an existing compatible environment

The selected directory must contain:

```text
.venv/Scripts/python.exe
models/model.int8.onnx
models/tokens.txt
models/zh.wav
```

The Python environment must have sherpa-onnx, NumPy, and imageio-ffmpeg installed. Copy the upstream package's `test_wavs/zh.wav` to `models/zh.wav` if needed, and retain its license. Applying a path tests actual recognition rather than only checking filenames. Copying another computer's `.venv` may fail because it can refer to an absolute base Python path.

### Upstream resources and licenses

| Resource | Official source |
| --- | --- |
| Original SenseVoice project and model information | [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) and [SenseVoiceSmall model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall). |
| Compatible ONNX INT8 model used by this plugin | [sherpa-onnx pretrained model documentation](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html) and [upstream model download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2). |
| Windows Python | [Python downloads](https://www.python.org/downloads/windows/). |
| Python dependencies | [sherpa-onnx](https://pypi.org/project/sherpa-onnx/), [NumPy](https://pypi.org/project/numpy/), and [imageio-ffmpeg](https://pypi.org/project/imageio-ffmpeg/) on PyPI. |

The original SenseVoice project and sherpa-onnx's converted ONNX release are separate sources. This plugin uses the latter's compatible model package. Models, Python, and these dependencies are not redistributed in the plugin ZIP or source repository. Their licenses are separate from this plugin's MIT license; see [third-party notices](THIRD-PARTY-NOTICES.md).

## Settings and processing

| Section | Purpose |
| --- | --- |
| Recording and paths | Choose separate vault-relative recording and finished-note folders, plus note naming and whether to include the year. Folder defaults are `Voice Diary/Recordings` and `Voice Diary/Notes`. Click **Apply** after editing a path. |
| Local recognition | Open upstream resources, apply a prepared environment directory, check the model, and choose the recognition language. |
| API cleanup | Apply an endpoint, model, and device-local Key together, explicitly enable the optional API, and select natural cleanup, faithful correction, or a custom prompt. |
| Text processing | Correct, translate, polish, or summarize selected note text. Preview the result before applying it. Requires the text API to be enabled and configured. |
| Voice tasks | Choose the task-note folder, record a task, review tomorrow/next-week/unconfirmed/all unfinished items, and optionally allow API task extraction. The folder defaults to `Voice Diary/Tasks`; API task extraction is off by default. |
| Tasks and recovery | Enable automatic processing, inspect progress, retry failures, retry with changed API settings, or migrate an older desktop configuration. |

Paths must be relative to the vault. Changing a path affects future recordings or tasks and does not move history. Tasks already in progress keep their assigned destination.

### Diary filenames and dates

New tasks default to `MM.DD日记_主题.md`, for example `12.13日记_出游.md`. Under **Finished-note naming** (`成品笔记命名`), you can keep the original audio filename plus `-transcript` instead. **Include year in title** (`标题包含年份`) changes the diary form to `2026.12.13日记_出游.md`. The topic is extracted locally from this recording's text without an extra API request. A filename conflict gets a numbered alternative; it does not overwrite an existing note.

A diary day runs from 04:00 to the next day's 03:59. A recording started before 04:00 belongs to the previous day; one started at or after 04:00 belongs to the current day. New recordings put their **start time** in the original `voice-YYYY-MM-DD-HHmmss-…` filename, so crossing 04:00 while recording, delayed saving, retries, and synchronization do not change that source date. Source filenames containing a date but no time keep that date. For other audio, the Processor uses file creation time, falling back to processing time if unavailable; creation time can depend on the import or synchronization tool. Naming applies only to new tasks. Existing notes and destinations already assigned to in-progress tasks are preserved.

Automatic processing skips existing recordings the first time it is enabled. To process older audio, use the transcription command in the audio file's menu. The plugin observes vault audio entries in the configured recording folder, waits for incoming files to become stable, and processes them one at a time. It retains original audio and uses source fingerprints to avoid duplicates. Existing finished notes and manual edits are not automatically overwritten.

### Spoken tasks for tomorrow or next week

Choose **Record tasks** (`录制待办`) on the computer or in Recorder 0.4.0. Stop and save as usual. For example, say “明天买牛奶，下周整理出游照片” (buy milk tomorrow; organize trip photos next week). The computer transcribes the recording locally and creates a separate Markdown task note in your chosen task folder. The ordinary microphone continues to create diary recordings.

Each task recording saves both audio and an adjacent `<audio filename>.voice.json` file. Synchronize both files, including `.json`, before expecting processing. The companion file records the recording's actual start date/time, time zone, identity, and audio fingerprint. Missing, incomplete, or mismatched companion data leaves that recording waiting; the plugin does not guess its date from arrival time. Keep these files together when moving or backing up a recording.

Relative dates use the **actual local date when recording started**, independently of the diary's 04:00 rule. At 03:59 on November 7, a diary belongs to November 6, but “tomorrow” in a task recording means November 8. “Next week” means the following Monday–Sunday range; it does not invent a deadline. Saved dates stay fixed after late synchronization or a time-zone change. The tomorrow and next-week views use the computer's current local date to select from those saved dates.

Open the **Voice tasks** settings section or the task-view commands to review tomorrow, next week, items needing confirmation, or all confirmed unfinished items. A note such as `2026.11.07待办_153000_a1b2c3d4.md` contains standard Markdown checkboxes, the original wording, dates, an audio link, and the full transcript. Checkboxes in the note are the completion record. You can confirm, edit, or cancel an item; edits made after opening a view require a refresh before that view can save over them. Conflicting copies are shown for manual review. The plugin does not create calendar events, notifications, or system reminders.

Local extraction recognizes explicit Chinese action and date expressions conservatively. Ambiguous dates, quotations, corrections, and negations can require confirmation; neither recognition nor extraction guarantees that every intention is captured. Review the source transcript, especially for important tasks. Long or overly complex input may be limited and marked for review. To use the text API for new task recordings, enable and configure the global API **and** turn on the separate task API option, which defaults off. The request contains this recording's transcript and recording-date context, without other notes or original audio. See the [voice-task guide](docs/VOICE-TODOS.md) for examples and recovery steps.

### Local-only mode and optional API cleanup

The text API is **off by default** on new installations. With the API off, or with required configuration missing, the finished note contains the local transcript and a `local_transcribed` property. No API account or Key is needed for this mode.

Endpoint, model, and Key inputs are drafts until you click **Apply API configuration** (`应用接口配置`). Apply them together while no processing task or API request is running. Applying configuration turns the API off; check the destination and credentials, then turn it on manually. Remote endpoints must use HTTPS. HTTP is allowed only for a loopback service on this computer. If the endpoint's origin (scheme, host, or port) changes and the draft still contains the previous service's Key, that Key is cleared. Enter the new service's own credentials and apply again before enabling it.

When you explicitly enable and configure the API, the plugin sends transcript text and instructions to your chosen compatible endpoint. Long recordings are divided into sections; context is limited to neighboring transcript sections from the same recording. It does not read contacts, a personal vocabulary list, or unrelated notes, and it does not send original audio. Review names, numbers, and important facts against the recording.

Selection actions send only the selected text and the relevant instructions. A connection test sends a short test message only when clicked. Required credentials are sent to the configured service as request credentials. Its pricing, terms, and retention policies are determined by your chosen provider.

Turning the API off retains its saved configuration. It stops later requests but cannot retract a request already sent. Turning it back on does not automatically rewrite existing notes. To verify offline operation, disable the API and transcribe a short recording after preparing the local environment.

## Record on a phone and synchronize

Install [Voice Diary Recorder](https://github.com/jem-code-sss/obsidian-voice-diary-recorder) on the phone and this Processor on the Windows computer. Syncthing is one option, not a requirement: Obsidian Sync or another reliable vault synchronization tool can also transfer the files. The plugins do not provide a synchronization service.

1. Configure the same vault-relative recording folder on both devices. Their absolute vault paths may differ.
2. Synchronize the recordings, finished-note, and task-note folders in both directions. For voice tasks, include the adjacent `.voice.json` files as well as audio. Avoid using multiple synchronization tools to manage the same folders.
3. Install each plugin on its intended device. Keep the Python environment, API credentials, and desktop task data outside the shared folders.
4. On the phone, keep Obsidian in the foreground, record a short sample, stop, and play it back. Wait for the saved file to synchronize.
5. Keep the computer and Obsidian running, with automatic processing enabled on that computer only. After the audio is stable, the Processor creates a diary note such as `12.13日记_出游.md` with a source audio link, using your selected naming mode.
6. Wait for synchronization back to the phone, then check the note and audio playback.

For Syncthing, start with its [official downloads](https://syncthing.net/downloads/) and [getting-started guide](https://docs.syncthing.net/intro/getting-started). Choose a maintained, compatible client for your phone: the [old official Android application was discontinued](https://github.com/syncthing/syncthing-android#discontinued). A detailed Chinese walkthrough is available in [installation and synchronization](docs/SETUP.md).

The phone can record offline in the foreground and synchronize after reconnecting. Save successfully before leaving the app. Locking the phone, switching apps, or a microphone interruption ends the current segment and attempts to save it; the notice disappears shortly afterward. Start a new recording after returning. The Recorder does not support continuous background recording, and a system freeze or forced shutdown may prevent saving.

Both recording entry points verify saved bytes. If a failed write leaves a truncated file or the target is occupied by different content, the plugin preserves that file and saves the complete recording under a new name containing a full UUID. Check for the complete replacement before removing an abnormal file. A recording that still cannot be saved remains in memory for retry; keep Obsidian open until saving succeeds.

## Privacy, external files, and process execution

Original recordings and finished notes remain in your selected vault folders and follow your synchronization and backup settings. The plugin has no telemetry.

Task companion files also follow vault synchronization. They expose the recording time, time zone, random recording ID, audio filename, size, and SHA-256 fingerprint, but do not contain an API Key or transcript. Task notes contain personal plans and the full transcript; treat them as private notes. A fingerprint checks file consistency and is not encryption or proof of who created a recording.

Desktop configuration, API credentials, and task checkpoints are stored **outside the vault**, under the current user's application data directory. A task checkpoint can contain transcript text and processed sections. On Windows, the device file is:

```text
%LOCALAPPDATA%\voice-diary-unified\<vault-id>\device.json
```

The vault identifier is derived from the local vault path; it is not an access token or a guarantee of anonymity. API Keys, task JSON, and backups are stored in plaintext, not in a system credential vault. Do not synchronize or share these files.

Device storage uses a short-lived transaction guard for lock ownership changes, checks the lock's file identity and random owner token before writing, and refuses symbolic links, directory links, and state files with multiple hard links. State and backup files use randomly named temporary files created exclusively, then atomic replacement. These checks reduce accidental cross-window writes and unsafe file replacement; they do not isolate the plugin from a compromised operating system or another program running as the same user. A hard crash during a guard transaction can rarely leave `device.guard` behind and block startup. Close **all Obsidian windows**, confirm that no Obsidian process is running, and inspect the device data directory before handling a confirmed leftover guard. Do not remove a guard belonging to a running process.

Direct filesystem access is used for this device data, its backups, the configured external recognition environment, runner caching, and task-specific temporary audio and result files. The plugin extracts its embedded Python runner to `%LOCALAPPDATA%\voice-diary-unified\runtime-cache\<version>`, verifies the content, and uses that local copy. It does not download updated plugin code. Normal completion, failure, and cancellation clean up task temporary files; a crash or power loss can leave them behind.

The Processor starts the Python executable from the local environment you selected, with fixed runner arguments and no command shell. That local runner uses FFmpeg and sherpa-onnx to read and transcribe the audio. On cancellation, Windows may run its built-in process termination utility to stop only the recognition process tree started by the plugin. These capabilities support local recognition; the plugin does not run the dependency installer or arbitrary shell commands supplied by a note. Only use a recognition environment you trust.

The decoder accepts supported self-contained audio containers and uses container and audio-decoder allowlists during probing and conversion, without enabling unneeded video or image decoders. Playlists and manifests are rejected, and MOV external media tracks are disabled, to prevent a recording from directing decoding to another local file or network resource. Renaming a playlist to an audio extension does not make it supported. FFmpeg and the recognition environment remain external native dependencies; these restrictions do not establish that those dependencies are free of vulnerabilities. Keep the environment trusted and maintained.

Clipboard access only writes the displayed text-processing result when you click **Copy** in its preview. The plugin does not read the clipboard. The separate Recorder uses device-local storage for its recording folder; desktop task state is stored in the external device file described above.

Local recognition runs on the computer without an online transcription service. Optional text API requests occur only under the conditions described above. Opening a resource link uses your browser; a setup script you manually launch contacts official Python, PyPI, and GitHub download services. The setup process does not upload your recordings or notes. Your synchronization tool, Obsidian, the operating system, and other plugins have their own network behavior.

Uninstalling does not automatically remove recordings, notes, the external recognition environment, or device-local data. See [PRIVACY.md](PRIVACY.md) for the detailed Chinese data-flow and cleanup information.

## Development and verification

Developers need Node.js 22 or newer. From the source root:

```powershell
npm ci
npm test
npm run build
```

The build is written to `dist/voice-diary-unified/`. Node tests use simulated host, HTTP, and process behavior; they do not call a paid text API.

Python runner tests require NumPy. Use the prepared environment's Python:

```powershell
& '<SenseVoice-directory>\.venv\Scripts\python.exe' -B -m unittest discover -s tests -p 'test_*.py' -v
```

The offline Windows setup regression tests use PowerShell 5.1:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/test_setup_sensevoice.ps1 -PythonPath '<SenseVoice-directory>\.venv\Scripts\python.exe'
```

See [validation notes](VALIDATION.md) for coverage, local checks, and remaining device tests. Report issues in [GitHub Issues](https://github.com/jem-code-sss/obsidian-voice-diary/issues) with the version, system, reproduction steps, and safe error message. Do not attach API Keys, complete personal paths, `device.json`, or private recordings.

## Limitations and license

- Transcription processes saved files, rather than providing live captions. Each task starts Python and loads the model.
- Noise, accents, proper nouns, and long sentences can still cause recognition errors. Rejecting completely silent input is not full voice activity detection.
- Voice-task extraction is an aid to review, not a promise that every action or date is understood. It does not schedule reminders; the mobile Recorder only records, while Processor provides the task views.
- Device-local task state and credentials do not synchronize. Prepare a new environment and configuration when moving to another computer.
- If local pending content and recovery checkpoints are completely lost, an older source-marked note may be a manual edit or a historical partial write. The plugin preserves it; check against the recording and save a separate replacement if needed.
- Local preparation depends on access to the upstream services and on local permissions.
- Mobile recording is a separate foreground-only function; the phone does not run local transcription or API cleanup.

Plugin code is licensed under [MIT](LICENSE). SenseVoice models and external components retain their own licenses; see [third-party notices](THIRD-PARTY-NOTICES.md).
