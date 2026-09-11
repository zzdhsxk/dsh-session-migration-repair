# dsh-session-migration-repair

> 修复**无法被当前 DSH 版本迁移**的旧版（format v0）会话日志：诊断 → 备份 → 修复 → 用宿主自带的迁移链离线验证 → 落盘。

[English](./README.md) | **中文**

## 它解决什么问题

DSH 0.1.5 起，会话存储格式升级到 v3；打开老会话时 DSH 会走 v0 → v1 → v2 → v3 的迁移链，并对每一步做严格校验。旧版本写入时留下的空字段，当时的版本并不在意，但在迁移链上会直接拒绝，表现为「历史加载失败 / history unavailable」。本工具处理的就是这类日志。

它修的四类确定性缺陷（全部可自动修复）：

| 报错 | 真因 | 修法 |
|---|---|---|
| `released tool-call-chunks row N id and optional name must be strings` | 流式工具调用的分片行 `id` 为空（旧版只在首行写 id） | 从同 `turn\|step\|index` 的 `assistant/chunk tool-call-delta` 取回真实 id/name |
| `assistant/message N message content[k] name must be a non-empty string` | 工具调用块的 `name` 为空（常见于更早的修复工具改写之后） | 从同 step 的 delta 取回工具名 |
| `format v2 assistant/message ... invalid message content kind "tool-call": user/message 0 content[0] id must be a non-empty string` | `assistant/chunk` 的 `block-end` 里 tool-call 块的 `id` 为空（**外层报错是误导**，内层才是真因） | 同样用 delta 的 id 补齐 |
| `tool/call ... does not match one advertised tool call` | `tool/call.arguments` 与消息里对外声明的 arguments 不一致 | 以**未含替换字符（U+FFFD）的一侧**为准，两侧写回同一份 |

## 安装

作为 DSH 插件（宿主侧注册一个模型可调用的工具 + 一个技能）：

```bash
dsh plugin --profile web add dsh-session-migration-repair        # 从 npm
dsh plugin --profile web add github:<owner>/dsh-session-migration-repair   # 从 GitHub
# 之后重启 dsh web 并刷新页面
```

也可以完全脱离 DSH 单独用命令行（零依赖，只需要 Node ≥ 20）：

```bash
node bin/cli.mjs --help
```

## 命令行

```bash
dsh-session-migration-repair list                      # 列出所有会话（含代际与隔离文件）
dsh-session-migration-repair scan   <会话ID|路径>      # 只读诊断，不改任何文件
dsh-session-migration-repair validate <会话ID|路径>    # 跑完整迁移链（等价于"打开会话"，但不影响服务）
dsh-session-migration-repair fix    <会话ID|路径> --yes # 备份 → 修复 → 校验 → 落盘
```

常用选项：`--dry-run`（只报告将改哪些行）、`--no-fix-arguments`（不动 arguments）、`--dsh-home <dir>`、`--dsh-root <dir>`（指定 DSH 安装位置用于离线校验）、`--json`。

示例输出：

```text
$ dsh-session-migration-repair scan session-61c010f4-...
行数               : 59289
阻塞迁移的缺陷     : 160
  - packedChunkMissingId        : 112
  - messageToolCallMissingName  : 12
  - blockEndMissingId           : 12
  - blockEndMissingName         : 12
  - toolCallMissingName         : 12
工具链             : advertised=607 calls=607 results=607

$ dsh-session-migration-repair fix session-61c010f4-... --yes
已修复 session-61c010f4-...
  备份      : ~/.dsh/session-migration-repair/backups/<时间戳>/....pre-repair.jsonl.zstd
  改动行数  : 148
  体积      : 12280330 → 3851062 字节
  迁移链    : 通过 ✅ (3530 个 v3 事件)
```

## 安全设计

- **先备份后改写**：原件复制到 `$DSH_HOME/session-migration-repair/backups/<时间戳>/`，并追加一条审计记录到 `audit/repair-log.jsonl`。
- **最小差异**：只重新序列化真正变化的行（实测 59,289 行的会话只改 148 行），其余行原样保留。
- **写前验证**：修复结果先在本地跑完整 v0→v1→v2→v3 迁移链，通过才落盘；写文件用「临时文件 + rename」保证原子性。
- **零依赖**：不引入任何 npm 依赖，自带多帧 zstd 读写（DSH 的日志是多帧的，且**首帧必须只含 header 一行**；Node 自带的 zstd 只能解首帧）。

## 原理

1. **多帧 zstd**：`lib/core/zstd.mjs` 自己按帧边界拆分（只解析帧头与块头，不重实现压缩），逐帧解压后一次性 UTF-8 解码 —— 直接逐块拼接字符串会在块边界切断多字节字符，凭空制造 U+FFFD。
2. **缺陷索引**：每一次流式工具调用都由 `assistant/chunk` 的 `tool-call-delta` 宣告（含真实 id 与工具名），因此所有空字段都能从这张索引里补回。
3. **离线验证**：DSH 的 `sessionFormatCatalog.createRestore()` 就是它自己的装载路径，本工具直接驱动它 —— 校验结果与真实打开会话完全一致，不需要反复重启服务试错。

## 局限

- 只能修**文件仍在**的日志（哪怕只剩 `.corrupt-*` 隔离备份）。整个会话目录被 `rm -rf` 的情况，本工具无能为力。
- 只处理上述四类确定性缺陷；迁移链报出其它错误时会**拒绝写入**并原样保留文件。
- 若日志里的文本本身已被写坏（含 U+FFFD），本工具只能保证「不再新增」破坏，无法凭空还原丢失的字符。

## 开发

```bash
node --test test/*.test.mjs                 # 单元测试
DSH_REAL_V0_LOG=/path/to/defective.jsonl.zstd node --test test/*.test.mjs   # 真实日志回归
```

## 许可

MIT
