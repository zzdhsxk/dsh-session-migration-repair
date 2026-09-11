---
name: dsh-session-migration-repair
description: 诊断并修复无法迁移到当前格式的旧版（v0）DSH 会话日志
when_to_use: 打开历史会话时报 SessionFormatError / refuses this format v0 Session / stored log is corrupt / history unavailable
---

# 旧版（v0）DSH 会话日志修复

## 何时使用
打开某个历史会话时出现下列任一错误：
- `@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: ...`
- `@deepseek-ai/dsh-session-format-v2-to-v3 refuses this format v2 Session: ...`
- `stored session "..." is corrupt: ... SessionFormatError ...`
- 前端只显示「历史加载失败 / history unavailable」

## 心智模型（先理解再动手）
1. DSH 0.1.5+ 会把旧日志按 v0 → v1 → v2 → v3 迁移，每一步都会校验；旧版写入时留下的空字段会在这里被拒。
2. 会话目录里可能有多个「代」的文件：`session.jsonl.zstd`（v0）、`session.v3.jsonl.zstd`（v3）、`session.jsonl.zstd.corrupt-<ms>`（被隔离的旧数据）。**文件名里的代必须与 header 里的 version 一致**，否则整个会话列表扫描都会失败。
3. 一个 zstd 会话文件是**多帧**的，且**首帧必须只含 header 一行**；用 Node 自带的 zstd 只能解出首帧，必须自己按帧边界拆分。

## 步骤
1. 定位工件：`dsh-session-migration-repair list`，或直接看 `$DSH_HOME/sessions/<project>/<session-id>/`。
2. 只读诊断：`dsh-session-migration-repair scan <session-id>`，关注 `blocking` 与各类 defect 计数。
3. 离线复现：`dsh-session-migration-repair validate <session-id>` —— 这一步会用宿主自带的 format catalog 跑完整迁移链，等价于「打开会话」但不影响服务。
4. 备份并修复：`dsh-session-migration-repair fix <session-id> --yes`（自动先备份、只重写真正变化的行、修复后再次跑迁移链校验）。
5. 让服务重新读取：刷新页面即可（会话内容在打开时从磁盘读取）；必要时 `dsh-daemon restart`。

## 常见缺陷与修法
| 症状 | 真因 | 修法 |
|---|---|---|
| v0→v1 拒绝 `released tool-call-chunks row N id ... must be strings` | 分片行 `id` 为空（旧版只在首行写） | 从同 `turn|step|index` 的 `assistant/chunk tool-call-delta` 取回 id |
| v0→v1 拒绝 `assistant/message N message content[k] name must be a non-empty string` | 工具调用块 name 为空（被早期修复工具改写） | 从同 step 的 delta 取回工具名，同时补齐 `tool/call` 的 name |
| v2→v3 拒绝 `invalid message content kind "tool-call": user/message 0 content[0] id must be a non-empty string` | `assistant/chunk` 的 `block-end` 里 tool-call 块的 id 为空（外层报错是误导，内层才是真因） | 同样用 delta 的 id 补齐 |
| v0→v1 拒绝 `tool/call does not match one advertised tool call` | `tool/call.arguments` 与消息里声明的 arguments 不一致 | 以**未含 U+FFFD 的一侧**为准，两侧写回同一份 |

## 坑点
- **不要**用 `process.stdin.on("data", c => text += c)` 读日志：逐块 UTF-8 解码会在块边界切断汉字，凭空制造 U+FFFD。要 `Buffer.concat` 后一次性 `toString("utf8")`（本工具的 `decodeLog` 已处理）。
- **不要**整文件重新序列化：只重写真正变化的行，差异面越小越安全。
- 修复前务必备份；`fix` 默认会写到 `$DSH_HOME/session-migration-repair/backups/<时间戳>/` 并记审计。
- 若会话目录被整体 `rm -rf`（连 `.corrupt-*` 都没了），本工具无能为力——只能从外部备份恢复。
