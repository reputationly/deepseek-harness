---
kind: upgrade-guide
description: "桌面安装包、更新对象与安装后可执行文件改用 ASCII 标识 suanli-assistant。"
---

# 桌面产物与可执行文件改用 `suanli-assistant`

[English](guide.md) | 中文

## 变更

打包文件名不再沿用上游产品名。下载名、更新源对象和保留的发布文件从 `deepseek-harness-<版本>-<os>-<arch><后缀>.<扩展名>` 改为 `suanli-assistant-<版本>-<os>-<arch><后缀>.<扩展名>`；未签名构建仍保留 `-unsigned` 后缀。

安装后的可执行文件也改名。macOS 应用包名仍是 `蒜狸小助手.app`，Windows 安装目录与显示名不变，但它们内部的可执行文件改为 `Contents/MacOS/suanli-assistant` 和 `suanli-assistant.exe`，不再使用显示名。两者都由 `brand.json` 的 `packageName` 经 `apps/desktop/scripts/desktop-brand.mjs` 的 `ARTIFACT_BASENAME` 和 `EXECUTABLE_NAME` 派生，后续更换品牌时一起改名。

受影响的是解析下载桶、按字节固定安装包 URL、按路径启动已安装二进制或把快捷方式指向可执行文件的场景。稳定的官网地址（`dsh-latest-macos-arm64.dmg`、`dsh-latest-windows-x64.exe`）不变。

## 迁移

1. 把脚本、配置、镜像和文档中命名安装包或更新对象的 `deepseek-harness-` 换成 `suanli-assistant-`。旧前缀下已发布的对象仍然有效，但本次发布不再生成。
2. 按新名称启动已安装的可执行文件：Windows 用 `suanli-assistant.exe`，macOS 用 `蒜狸小助手.app/Contents/MacOS/suanli-assistant`。同步更新指向旧文件的快捷方式、计划任务和 `PATH` 项。
3. 若你的发布流程调用版本建议器，继续显式传入 `DSH_DESKTOP_BUILD_VERSION`。列举只匹配 `suanli-assistant-` 对象，以 `deepseek-harness-` 发布的构建不再占用版本号。
4. 重新运行打包后的启动器 `dsh --profile desktop --help`，确认它输出帮助而不是报找不到可执行文件，再确认自己的下载目录里出现了新的安装包文件名。
