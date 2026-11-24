---
kind: upgrade-guide
description: "Desktop 发布包不再携带原生 LibreOffice 引擎；应用在首次启动时把它下载到 $DSH_HOME，因此 Office 转换需要一次可达的 npm registry。"
---

# Desktop 在首次启动时下载 LibreOffice 引擎

[English](guide.md) | 中文

## 变更

过去每个 Desktop 发布包都在应用内携带原生 LibreOffice 引擎（`@deepseek-ai/libreoffice-kit-<platform>-<arch>`，压缩后约 60 MB），因此首次启动即可离线完成 Office 转换。

现在发布包只携带锁定的引擎身份 `resources/office-engine.json`：包名、版本，以及该版本记录的 npm SHA-512 完整性。应用启动时按顺序向 npm registry（先是 `https://registry.npmjs.org/`，再是 `https://registry.npmmirror.com/`）下载这个确切的 tarball，校验锁定完整性后解包到 `$DSH_HOME/dsh-runtimes/office-kit`。Host 收到该目录作为 `DSH_OFFICE_ENGINE_DIR`，Office 提供方从那里解析引擎。

启动路径的其他部分不变：下载在后台进行，下载完成前到达的转换会返回提供方本地化的 `unavailable` 提示，稍后重试即成功。无法访问任何 registry 的机器只失去 Office 转换（预览、PDF 转换和重算），其余功能不受影响。开发运行、源码运行的 `dsh web` 以及 Python SDK 侧载都不受此影响，它们照常安装引擎。

安装包体积随之下降：macOS arm64 未签名 DMG 在内置引擎时为 326 MB，改为预置后为 265 MB；同一版本中压缩与语言裁剪之前的基线是 372 MB。

## 迁移

1. 接受新的行为时无需修改。确认：联网启动一次后，`$DSH_HOME/dsh-runtimes/office-kit/@deepseek-ai/libreoffice-kit-<platform>-<arch>/package.json` 存在，且 DOCX 预览可以转换。
2. 若要为隔离网络的机群预先准备，在首次启动前把同一个包目录放到 `$DSH_HOME/dsh-runtimes/office-kit/` 下；`package.json` 声明了锁定名称与版本的包会被复用而不下载，其他内容会被替换。
3. 若要继续把引擎放在应用内，让打包不执行 `runtime:office-engine-sidecar` 这一步即可：`resources/office-engine.json` 只在该步骤删除引擎包之后才写入，因此停在它之前的构建仍然携带引擎，也不需要下载。
