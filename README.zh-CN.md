# Voice Diary Processor

[English](README.md) | 简体中文

用 Windows 电脑上的 SenseVoice 将录音转成 Obsidian 笔记，按需开启文字 API 整理。版本：**0.3.1**。

原始录音和成品笔记分别保存，路径由你指定。不填写 API 配置、或关闭 API 开关时，只进行本地识别。

## 适用设备

- **Windows x64 桌面端**：录音、SenseVoiceSmall INT8 CPU 转写、可选文字 API 整理。
- **手机配套**：[Voice Diary Recorder](https://github.com/jem-code-sss/obsidian-voice-diary-recorder) 单独安装，只录音并保存文件，通过同步工具交给电脑处理。录音时保持 Obsidian 在前台。本插件为桌面专用，不能代替手机录音插件。
- 目前未承诺 macOS、Linux、Windows ARM 或手机端本地转写可用。

插件需要 Obsidian 1.8.7 或更新版本。无需显卡；首次手动准备识别环境需要联网和足够磁盘空间，之后本地转写可以离线使用。必备软件、Syncthing 配置与完整步骤见 [安装与同步教程](docs/SETUP.md)。

## 安装

可从 [Obsidian 官方社区目录](https://community.obsidian.md/plugins/voice-diary-unified) 或 Obsidian 第三方插件设置安装 Voice Diary Processor；当前收录与版本审核状态以官方页面为准。也可手动安装：

1. 在 [0.3.1 Release](https://github.com/jem-code-sss/obsidian-voice-diary/releases/tag/0.3.1) 下载 `voice-diary-unified-v0.3.1.zip`，完整解压。
2. 正常退出 Obsidian，把包内 `voice-diary-unified` 文件夹复制到仓库的 `.obsidian/plugins/` 下。自定义配置目录的用户应使用对应的 `plugins` 目录。
3. 重新打开 Obsidian，在「第三方插件」中启用 **Voice Diary Processor**。
4. 按下文手动准备本地识别环境，在「本地识别」应用其目录；已有兼容环境可直接复用。
5. 在「录音与路径」确认录音和笔记目录，再到「任务与恢复」启用本电脑自动处理，录一段短音频进行验证。

升级时覆盖插件程序文件即可。现有路径、API 开关和任务记录继续保留，已有录音和笔记不会迁移到新默认路径。建议只在一台电脑开启自动处理。

从原来的电脑/手机合一版本升级时，请先在手机安装 Voice Diary Recorder，确认它沿用原录音目录，并测试保存与同步；再升级电脑端 Processor。Processor 已改为桌面专用，不能继续承担手机录音。停用旧手机录音入口，避免两个麦克风按钮；若同步 `.obsidian`，请先确认手机 Recorder 可用，再覆盖电脑端旧插件。

目录发布与审核流程见 [上架说明](docs/MARKETPLACE.md)。市场发布同时提供 `main.js`、`manifest.json`、`styles.css` 三个标准附件；手动 ZIP 仅是另一种安装方式。

## 手动准备本地识别

插件不会安装、下载或更新依赖。「本地识别」的资源按钮只在浏览器打开上游模型和手动准备说明。用户可从上游自行准备兼容环境，或下载本项目源码 ZIP，在 Obsidian 外自行执行附带的 Windows 准备脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File runtime/setup-sensevoice.ps1
```

该脚本由用户手动执行，读取同目录的准备程序与固定依赖清单，从 Python 官网、PyPI 与官方模型发布下载资源，核对模型四个文件的 SHA-256，并运行官方短样例。不读取录音、笔记或 API Key；它不由插件启动。完成后回到插件点击「检查并准备」。

脚本默认将环境放在 `%LOCALAPPDATA%\voice-diary-unified\sensevoice`，不会进入仓库同步。此时插件安装目录输入框留空即可；已有自选环境不会被覆盖。手动脚本优先复用兼容的本机 Python 3.10–3.12；缺少时安装官方 Python 3.12，按用户安装、不添加 PATH 或文件关联，但可能注册为本机可发现的 Python 安装。自选位置可给脚本传入 `-Root '<本机目录>'`，并在插件中应用同一目录。

资源来源：

| 资源 | 上游 |
| --- | --- |
| SenseVoice 原始项目与模型说明 | [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)、[SenseVoiceSmall 模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) |
| 插件使用的 ONNX INT8 模型包 | [sherpa-onnx 官方模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[上游模型下载](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2) |
| Windows Python | [Python 官网](https://www.python.org/downloads/windows/) |
| Python 运行依赖 | PyPI 上的 [sherpa-onnx](https://pypi.org/project/sherpa-onnx/)、[NumPy](https://pypi.org/project/numpy/)、[imageio-ffmpeg](https://pypi.org/project/imageio-ffmpeg/) |

SenseVoice 原开发项目与 sherpa-onnx 的 ONNX 转制发布是不同来源；插件使用后者提供的兼容模型包。模型、Python 和第三方依赖不包含在插件 ZIP 或本仓库中，其许可独立于插件的 MIT 许可，见 [第三方声明](THIRD-PARTY-NOTICES.md)。

已有环境可直接在「本地识别」中填写本机安装目录并点击「应用路径」。目录应包含 `.venv/Scripts/python.exe`、`models/model.int8.onnx`、`models/tokens.txt` 和 `models/zh.wav`，Python 环境内需已安装上述依赖及其 FFmpeg。原模型包中的 `test_wavs/zh.wav` 可复制为 `models/zh.wav`。应用路径会验证实际识别，而不只检查文件名。

准备成功后，关闭文字 API、断开网络也可转写本地录音。离线复用依赖有效的 Python 环境；直接把另一台电脑的 `.venv` 复制过来，可能因基础 Python 的绝对路径而失效。

## 五个设置分区

| 分区 | 用途 |
| --- | --- |
| 录音与路径 | 新装默认录音目录 `Voice Diary/Recordings`、成品目录 `Voice Diary/Notes`；均为仓库内相对路径，输入后点击「应用」。手机与电脑的录音目录须一致。 |
| 本地识别 | 官方模型与手动准备说明链接、已有环境目录、检查模型、识别语言。 |
| API 整理 | 独立开关、完整接口地址、模型名和本机凭据；自然整理、忠实校对或自定义提示词。 |
| 文字处理 | 对笔记选区校对、翻译、润色、总结等，结果先预览，确认后应用。需要文字 API 已启用且配置完整。 |
| 任务与恢复 | 自动处理开关、进度、失败重试、接口变更后重新整理及旧插件配置迁移。 |

更改默认目录只影响之后创建的录音或任务；已有文件保留原位，处理中的任务保留已确定的目标位置。

API 关闭或必要配置未填完整时，成品保存本地转写原文，并带 `local_transcribed` 属性。API 启用且配置完整时，插件将转写文字发送给你指定的兼容接口；长稿分段整理，只引用同一录音的相邻转写作为上下文，不读取通讯录、常用词表或其他笔记。数字、人名和重要事实仍需对照录音核对。

关闭 API 不会清空已填配置；已发出的请求无法撤回，后续片段停止调用。已有成品不会因为重新开启 API 就自动重写。连接测试只在点击时发送简短测试文字。

## 手机与电脑同步

手机先安装 [Voice Diary Recorder](https://github.com/jem-code-sss/obsidian-voice-diary-recorder)，电脑安装本插件。主教程使用 **Syncthing**，也可换成 Obsidian Sync 或其他可靠同步工具；插件本身不提供同步服务。只在一台电脑录音与识别时不需要同步软件。

手机先保存录音，电脑同步收到后等待文件稳定，再串行处理并保存笔记。成品及音频通过原同步工具回到手机。手机离线时也能在前台录音；待文件保存成功再离开应用。

手机配套插件锁屏、切后台或麦克风中断时会结束本段并尝试保存，提示短暂显示；返回前台后需重新开始。系统冻结或强制结束应用时可能来不及保存，配套插件不保证后台持续录音。

## 文件保护与隐私

自动处理首次开启会跳过已有录音。需处理历史文件时，使用音频文件菜单中的转写命令。插件保留原始音频，按来源指纹避免重复处理；已完成笔记和人工修改的历史稿不会被自动覆盖。

本地识别使用临时音频和结果文件，正常结束、取消或失败后清理；程序崩溃或系统断电可能遗留临时文件。本机任务检查点含转写正文，API Key 以明文保存在仓库之外的设备数据目录，不能视作加密保管。为兼容市场三文件安装，插件仅将随 `main.js` 内置的识别 runner 释放到 `%LOCALAPPDATA%\voice-diary-unified\runtime-cache\<version>`，校验内容后使用；不会联网下载或执行更新的插件代码。详细数据流见 [隐私说明](PRIVACY.md)。

仓库外读写仅用于设备配置与任务、其备份、指定的本地识别环境、runner 缓存和本次识别的临时文件。插件通过固定参数启动用户指定环境内的 Python，不经命令 shell；本地 runner 使用 FFmpeg 和 sherpa-onnx。取消时可调用 Windows 自带的进程终止工具，结束本插件启动的识别进程树。插件不启动依赖安装程序，也不执行笔记内提供的任意 shell 命令。请只使用可信任的本地环境。剪贴板只在用户点击文字处理结果中的「复制」时写入该结果，不读取剪贴板。

## 开发与验证

构建与测试建议使用 Node.js 22 或更新版本。以下命令在项目根目录执行：

```powershell
npm ci
npm test
npm run build
```

构建输出为 `dist/voice-diary-unified/`，可按上述手动安装方法复制到测试仓库。Node 测试使用模拟宿主、HTTP 和进程，不调用真实付费接口。

Python runner 的单元测试需要 NumPy，并应使用已准备好的识别环境中的 Python：

```powershell
& '<SenseVoice目录>\.venv\Scripts\python.exe' -B -m unittest discover -s tests -p 'test_*.py' -v
```

Windows 下载引导的离线回归使用系统 PowerShell 5.1：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/test_setup_sensevoice.ps1 -PythonPath '<SenseVoice目录>\.venv\Scripts\python.exe'
```

测试范围、实测与待验事项见 [验证记录](VALIDATION.md)。可在 [Issues](https://github.com/jem-code-sss/obsidian-voice-diary/issues) 反馈问题，请说明版本、系统、出错步骤及安全错误提示，避免附带 API Key、完整本机路径、`device.json` 或私人录音。

## 已知边界

- 本插件仅桌面加载；手机配套插件不支持锁屏或切后台持续采集，也不进行识别或 API 整理。
- 识别为离线文件处理，不是实时字幕；每段任务会启动 Python 并加载模型。
- 环境噪声、口音、专有名词和长句仍可能误识别。全零静音过滤不等于完整语音活动检测。
- 本机任务状态和 Key 不随仓库同步；更换电脑后需重新配置。不要在多台电脑同时自动处理同一批录音。
- 下载需能访问上游服务；上游服务、代理和本机权限可能影响首次准备。

插件代码采用 [MIT 许可](LICENSE)。SenseVoice 及其他外部组件适用各自许可，见 [第三方声明](THIRD-PARTY-NOTICES.md)。
