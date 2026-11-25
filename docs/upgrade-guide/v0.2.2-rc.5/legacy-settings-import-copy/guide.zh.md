---
kind: upgrade-guide
description: "settings.yaml 的导入副本只保留被拒绝的分段，且不再保留其中的密钥值，因此插件的 API Key 不会再留在 settings.yaml.imported 里。"
---

# 旧版设置副本不再保留插件密钥

[English](guide.md) | 中文

## 变更

Host 启动时若在 harness home 发现 `settings.yaml`，会把它的分段一次性导入当前 profile，然后改名保存该文件。过去改名的 `settings.yaml.imported` 原样保留整份文档，其中的插件 API Key 会长期留在磁盘上。现在：

- 导入成功的分段不再复制——它们已经在 profile 补丁里——因此整份 import 成功的文档不会留下 `settings.yaml.imported`；
- 运行中的组合拒绝的分段会被保留，但其中被其实时 Config schema 标记为 `role('secret')` 的值已被移除；
- 被拒绝且对应插件条目已不存在的分段（例如已卸载的 bundle）原样保留，因为此时没有任何 schema 声明哪些字段是密钥；告警会指出该文件；
- 每次启动还会清除既有 `settings.yaml.imported` 里由更早版本留下的密钥值，只有确实删除了内容时才重写该文件。

同时存在该文档的升级用户会观察到这些变化。被拒绝的分段仍可用于恢复；已导入的分段照旧从 profile 补丁读取。

## 迁移

1. 接受新的行为无需任何修改。首次启动后确认：`<DSH_HOME>/settings.yaml` 已消失，并且要么没有 `settings.yaml.imported`，要么其中只剩被拒绝的分段且不含密钥。
2. 当日志告警指出某保留分段的条目已不存在时，查看该文件，在不再需要其中内容后删除：`rm "<DSH_HOME>/settings.yaml.imported"`。确认下次启动不再出现该告警。
3. 若在 harness home 中搜索到 `settings.yaml.imported` 里的密钥无法归属到任何条目（见第 2 步），用同一命令删除该文件；它只是恢复副本，从不是设置来源。
