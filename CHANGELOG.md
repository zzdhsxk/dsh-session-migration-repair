# Changelog

## 0.1.0 — 2026-09-12

首次发布。

- `scan` / `fix` / `validate` / `list` 命令行。
- 修复四类导致 v0→v3 迁移被拒的缺陷：空的分片行 id、空的消息侧 tool-call name/id、空的 block-end id/name、`tool/call` 与声明不一致的 arguments。
- 自带多帧 zstd 读写（零依赖，首帧只含 header，逐帧解压后一次性 UTF-8 解码）。
- 支持用宿主自带的 `sessionFormatCatalog` 离线跑完整 v0→v1→v2→v3 迁移链校验。
- 修复前自动备份、最小行差异改写、原子落盘、审计日志。
- 作为 DSH 插件注册模型可调用工具 `dsh_session_migration_repair` 与随包技能。
- 实测：59,289 行的真实会话修好 160 处缺陷、只改 148 行、产出与 `zstd -dc` 逐字节一致的 120 帧工件、迁移链通过（3,530 个 v3 事件）。
