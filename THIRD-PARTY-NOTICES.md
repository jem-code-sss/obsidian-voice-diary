# Third-party notices

Voice Diary Processor 0.3.0 的原创插件代码采用 [MIT 许可](LICENSE)。以下外部项目的代码、可执行文件或模型分别适用其上游许可；插件的 MIT 许可不授予这些外部资源的额外权利。

本仓库和插件安装包不包含模型权重、Python、Python 虚拟环境、FFmpeg、历史 Whisper worker 或 ONNX Runtime Web。用户手动准备环境时，这些资源直接来自对应上游；插件不安装或更新依赖。本插件不是其官方发行版，也不代表上游为本插件背书。

## SenseVoice 模型与运行环境

| 项目 | 来源与许可说明 |
| --- | --- |
| SenseVoice 原始项目 | [原开发者仓库](https://github.com/FunAudioLLM/SenseVoice)；其[源码 LICENSE](https://github.com/FunAudioLLM/SenseVoice/blob/main/LICENSE)为 MIT。 |
| SenseVoiceSmall 模型权重 | [官方模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)标注独立模型许可，链接至 [FunASR MODEL_LICENSE](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)。模型权重不因上游源码或本插件使用 MIT 而变成 MIT。下载、使用、修改和分享模型时应阅读并遵守其模型许可，保留来源、作者信息及模型名称。 |
| sherpa-onnx 及 ONNX 模型转制 | [项目](https://github.com/k2-fsa/sherpa-onnx)采用 [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)。[官方模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)将本插件使用的 SenseVoiceSmall INT8 包列为原始模型的 ONNX 转制版本，下载位于其 [asr-models 发布](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)。转制项目的源码许可与模型权重许可应分别遵守。 |
| Python | 来自 [Python 官网](https://www.python.org/)；适用 [PSF 许可及其随附组件许可](https://docs.python.org/3/license.html)。 |
| NumPy | [项目](https://numpy.org/)；适用 [BSD-3-Clause 及分发包随附声明](https://numpy.org/doc/stable/license.html)。 |
| imageio-ffmpeg | [项目](https://github.com/imageio/imageio-ffmpeg)采用 [BSD-2-Clause](https://github.com/imageio/imageio-ffmpeg/blob/main/LICENSE)。其平台 wheel 包含 FFmpeg 可执行文件，应同时查看 wheel 随附的 FFmpeg 许可声明。 |
| FFmpeg | [官方许可说明](https://ffmpeg.org/legal.html)区分 LGPL 与启用相应选项后的 GPL 构建；具体许可以实际下载的可执行文件和随附声明为准。 |
| ONNX Runtime 等传递依赖 | 由 Python 依赖安装时获取；适用各自分发包的 LICENSE/NOTICE，不包含在插件 ZIP 内。 |

`runtime/sensevoice_runner.py` 是本插件提供的本地进程适配程序，通过 sherpa-onnx Python API 使用用户的识别环境。上游权重、示例音频及其许可证留在外部资源目录中，不作为插件源码重新许可。

## 构建依赖

构建工具 [esbuild](https://github.com/evanw/esbuild) 采用 [MIT 许可](https://github.com/evanw/esbuild/blob/main/LICENSE.md)。它作为开发依赖由 `npm ci` 获取；`node_modules` 和 esbuild 可执行文件不在插件安装包中。

Obsidian 是运行宿主，不随本项目分发。Obsidian、SenseVoice、Python 和其他项目名称用于描述兼容关系，相关商标归原权利人所有。

## 历史兼容性

旧设置迁移仅在用户主动选择时读取已安装插件的配置字段。Voice Scribe 与 LLM Text Assistant 的可执行源码、UI 实现、内置提示词以及旧 Whisper/Transformers.js/ORT 资源均不包含在本次公开发布中。兼容设置字段不代表这些项目的许可被替换或其源码被重新许可。

如果修改本项目后选择将任何第三方模型、运行时或代码直接打包分发，请重新核对该资源的完整许可与声明要求；本文件的外部下载说明不能代替随附许可证。
