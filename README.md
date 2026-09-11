# dsh-session-migration-repair

> Repair legacy (format v0) DSH session logs that the current build **refuses to migrate**: scan → back up → fix → verify offline against the host's own migration chain → write.

**English** | [中文](./README.zh.md)

## The problem

Since DSH 0.1.5 a stored session is migrated through v0 → v1 → v2 → v3 on open, and every step is validated strictly. Fields that older builds wrote empty are rejected by the migration chain, surfacing as "history unavailable" for that session. This tool fixes exactly those logs.

Four deterministic defect classes, all auto-repairable:

| Error | Root cause | Fix |
|---|---|---|
| `released tool-call-chunks row N id and optional name must be strings` | streamed tool-call chunk rows carry an empty `id` (only the first row used to have it) | recover the real id/name from the `assistant/chunk tool-call-delta` of the same `turn\|step\|index` |
| `assistant/message N message content[k] name must be a non-empty string` | tool-call block `name` is empty (often after an earlier repair tool rewrote the chain) | recover the tool name from the same step's delta |
| `format v2 assistant/message ... invalid message content kind "tool-call": user/message 0 content[0] id must be a non-empty string` | the `block-end` tool-call block inside `assistant/chunk` has an empty `id` (**the outer message is misleading**) | fill it from the delta as well |
| `tool/call ... does not match one advertised tool call` | `tool/call.arguments` no longer equals the advertised block's arguments | align both sides, preferring the side **free of replacement characters (U+FFFD)** |

## Install

As a DSH plugin (registers one model-callable tool plus a bundled skill):

```bash
dsh plugin --profile web add dsh-session-migration-repair        # from npm
dsh plugin --profile web add github:<owner>/dsh-session-migration-repair   # from GitHub
# restart dsh web and reload the page
```

Or use the CLI standalone — zero dependencies, Node ≥ 20:

```bash
node bin/cli.mjs --help
```

## CLI

```bash
dsh-session-migration-repair list                      # list sessions (generation + quarantined files)
dsh-session-migration-repair scan   <session-id|path>  # read-only diagnosis
dsh-session-migration-repair validate <session-id|path># run the full migration chain offline
dsh-session-migration-repair fix    <session-id|path> --yes   # backup → repair → verify → write
```

Options: `--dry-run`, `--no-fix-arguments`, `--dsh-home <dir>`, `--dsh-root <dir>`, `--json`.

## Safety

- **Backup first**: the original is copied into `$DSH_HOME/session-migration-repair/backups/<timestamp>/` and an audit line is appended to `audit/repair-log.jsonl`.
- **Minimal diff**: only lines that actually change are re-serialized (a real 59,289-line session: 148 lines changed).
- **Verify before write**: the repaired log must pass the v0→v1→v2→v3 chain locally; the write itself is atomic (temp file + rename).
- **Zero dependencies**: multi-frame zstd read/write is built in — DSH logs are multi-frame and the **first frame must contain exactly the header line**, while Node's own zstd decoder only reads the first frame.

## How it works

1. **Multi-frame zstd** (`lib/core/zstd.mjs`): walks physical frame boundaries (frame and block headers only), decompresses frame by frame and decodes UTF-8 **once** — concatenating per-chunk decodes corrupts multi-byte characters that straddle a boundary.
2. **Defect index**: every streamed tool call is announced by an `assistant/chunk` `tool-call-delta` carrying the real id and tool name, so every empty field can be recovered.
3. **Offline verification**: DSH exposes its own load path as `sessionFormatCatalog.createRestore()`; this tool drives it, so the verdict matches what the server would do — no restart-and-click loops.

## Limitations

- Only logs that still exist (including `.corrupt-*` quarantined backups) can be repaired; a session directory removed with `rm -rf` is unrecoverable.
- Only the four defect classes above are handled; any other migration error makes `fix` refuse to write.
- Text already damaged (U+FFFD) cannot be restored — the tool only guarantees it will not add new damage.

## Development

```bash
node --test test/*.test.mjs                 # unit tests
DSH_REAL_V0_LOG=/path/to/defective.jsonl.zstd node --test test/*.test.mjs   # regression on a real log
```

## License

MIT
