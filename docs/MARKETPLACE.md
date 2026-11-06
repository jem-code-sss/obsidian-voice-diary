# Obsidian 社区目录发布

两个插件均已提交并公开到官方社区目录：

- [Voice Diary Processor](https://community.obsidian.md/plugins/voice-diary-unified)：电脑端录音处理与本地识别。
- [Voice Diary Recorder](https://community.obsidian.md/plugins/voice-diary-recorder)：手机或桌面前台录音。

目录条目公开、自动审核和客户端可安装是分别确认的状态；最新审核结果及安装入口以各自官方页面为准。0.3.2 包含安全修订与日记命名改进，提供完整英文 README，并保留中文指南；版本审核状态以官方页面显示为准。

两个插件分别发布、分别申请：

| 插件 | 仓库 | ID | 桌面专用 |
| --- | --- | --- | --- |
| Voice Diary Processor | https://github.com/jem-code-sss/obsidian-voice-diary | voice-diary-unified | true |
| Voice Diary Recorder | https://github.com/jem-code-sss/obsidian-voice-diary-recorder | voice-diary-recorder | false |

发布 `0.3.2` 等新版本时，tag 必须与 manifest.version 一致、不带 `v` 前缀。每个 Release 须提供 `main.js`、`manifest.json` 与 `styles.css` 标准附件。源码 ZIP 和手动安装 ZIP 不能替代这些附件。

Processor 的 Python runner 已内置在 `main.js` 中；市场安装不依赖额外复制 `runtime/` 文件夹。环境与模型由用户手动准备，插件仅提供官方资源及说明链接，不安装或更新依赖。

按目前[官方提交流程](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)，拥有者需要：

1. 登录 [Obsidian Community](https://community.obsidian.md)，使用自己的 Obsidian 账号。
2. 在个人资料连接 GitHub 账号，以验证仓库所有权。
3. 打开 Plugins → New plugin，输入对应仓库 URL，选择拥有者。
4. 阅读开发政策、确认维护承诺并提交；两个仓库分别操作。
5. 查看自动审核结果，根据反馈修改源码、递增版本并发布新 Release。

上述提交仅需在首次建立条目时执行。更新已有条目应在原仓库发布递增版本的 Release，并在官方后台检查新版本与审核结果，不要重复新建条目。目录登录和 GitHub 绑定由拥有者完成；GitHub Release 公开也不代表已通过 Obsidian 审核。

参考：[开发政策](https://docs.obsidian.md/community-directory/developer-policies)、[插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[账号设置与提交入口](https://docs.obsidian.md/community-directory/set-up-and-claim)。
