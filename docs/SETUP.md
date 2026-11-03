# 安装的软件与手机电脑同步

## 安装清单

| 使用位置 | 需要安装 | 用途 |
| --- | --- | --- |
| Windows x64 电脑 | [Obsidian](https://obsidian.md/download) 与 Voice Diary Processor | 接收录音、转写、保存成品，也可直接在电脑录音。 |
| 电脑的识别环境 | Python 3.10–3.12、SenseVoiceSmall INT8、sherpa-onnx、NumPy、imageio-ffmpeg | 仅电脑需要。可按 README 手动运行准备工具；FFmpeg 已随指定依赖提供，无需另装 Node.js 或显卡工具。 |
| 手机 | Obsidian 与 [Voice Diary Recorder](https://github.com/jem-code-sss/obsidian-voice-diary-recorder) | 只录音和保存；不用安装 Python、模型或 API 客户端。 |
| 手机与电脑之间 | Syncthing 或另一种可靠的仓库同步工具 | 将录音送到电脑，将成品送回手机。仅在一台电脑使用时不需要。 |
| 可选文字整理 | 自己选择的兼容文字 API | 不需要另装软件；填接口并显式开启后才使用。未配置或关闭时只做本地识别。 |

Syncthing 是同步工具，不负责语音识别。可以用 Obsidian Sync 等工具代替它；不要让多套工具同时管理相同目录。

## 用 Syncthing 配置

1. 电脑从 [Syncthing 官方下载页](https://syncthing.net/downloads/) 安装，按 [官方入门说明](https://docs.syncthing.net/intro/getting-started) 配对设备。手机需选择适合系统、仍在维护的兼容客户端；[旧官方 Android 应用已停止维护](https://github.com/syncthing/syncthing-android#discontinued)，不要把旧应用误认为当前官方安装推荐。iOS 用户可选择适合自己的仓库同步工具。
2. 两端各自用 Obsidian 打开准备同步的仓库，配置同一组共享文件夹。两端仓库的绝对磁盘路径可以不同；仓库内目录应一致。
3. 同步时至少包含 `Voice Diary/Recordings` 与 `Voice Diary/Notes`，采用双向读写。若共享整个仓库，也须确认音频和这两个目录没有被忽略。
4. 手机安装 Recorder、电脑安装 Processor。首次建议分别安装并启用，不依赖同步 `.obsidian` 目录分发插件；不要把 API 凭据、Python 环境或桌面设备数据放进共享目录。
5. 手机录音目录和电脑监听目录都设为 `Voice Diary/Recordings`。电脑的成品目录设为 `Voice Diary/Notes`，只在这一台电脑开启自动处理。
6. 手机保持前台录 10–20 秒，停止并回放。确认 Syncthing 显示同步完成后，等待电脑处理；插件会先观察录音稳定至少 30 秒。
7. 电脑生成 `原录音名-transcript.md`，包含可播放的源音频链接。等同步完成后，在手机打开成品并核对内容。

自定义目录也可以。升级用户继续使用原目录即可，别为了新默认路径移动历史录音或笔记。已有手机旧版目录可由 Recorder 的本机迁移保留；仍需手动确认电脑监听目录一致。

## 常见情况

- 电脑没开机、Obsidian 没打开或自动处理暂停：录音可先保存，电脑恢复后再处理。
- 手机离线：先确保录音成功落盘，联网后等待同步。未保存的内存录音不能靠同步找回。
- 只同步了笔记：成品里的音频链接无法播放。请同时同步原始音频。
- 手机锁屏或切后台：当前配套插件会结束本段并尝试保存，返回前台需重新开始；这不是后台持续录音方案。
- 录音出现在电脑但未处理：检查路径、同步是否完成、自动处理是否开启，以及本地模型检查结果。
- 重新安装或换电脑：模型和凭据属于设备数据，需要在新电脑重新准备，不从手机同步。
