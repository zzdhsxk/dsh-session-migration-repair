#!/usr/bin/env node
/**
 * dsh-session-migration-repair — CLI
 *
 * Repairs legacy DSH session logs that the current build refuses to migrate.
 */
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { backupArtifact, writeAudit, repairRoot } from "../lib/core/backup.mjs";
import { validateMigrationChain } from "../lib/core/chain-validate.mjs";
import { listSessions, resolveDshHome, resolveTarget, V0_ARTIFACT } from "../lib/core/locate.mjs";
import { parseLog } from "../lib/core/log.mjs";
import { repairLogText, scanLog } from "../lib/core/migration-repair.mjs";
import { decodeLog, decodeFirstFrame, encodeLog } from "../lib/core/zstd.mjs";

const NAME = "dsh-session-migration-repair";
const VERSION = "0.1.0";

const HELP = `${NAME} ${VERSION} — 修复无法迁移的旧版（v0）DSH 会话日志

用法:
  ${NAME} list                      列出所有会话（含代际与隔离文件）
  ${NAME} scan   <会话ID|路径>       诊断缺陷（只读，不改文件）
  ${NAME} fix    <会话ID|路径>       备份 → 修复 → 校验 → 落盘
  ${NAME} validate <会话ID|路径>     只跑完整 v0→v1→v2→v3 迁移链校验

选项:
  --dsh-home <dir>     DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --dsh-root <dir>     DSH 安装根目录（离线校验用；默认自动探测）
  --dir <dir>          直接指定会话目录
  --dry-run            只显示将要修改哪些行，不写文件
  --no-validate        fix 后跳过迁移链校验
  --no-fix-arguments   不调整 tool/call 的 arguments（只补 id/name）
  --json               以 JSON 输出
  --yes                跳过交互确认
  -h, --help           显示帮助
  -v, --version        显示版本
`;

function parseArgs(argv) {
  const options = { command: undefined, target: undefined, json: false, yes: false, dryRun: false, validate: true, fixArguments: true };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dsh-home": options.dshHome = argv[++index]; break;
      case "--dsh-root": options.dshRoot = argv[++index]; break;
      case "--dir": options.dir = argv[++index]; break;
      case "--json": options.json = true; break;
      case "--yes": case "-y": options.yes = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--no-validate": options.validate = false; break;
      case "--no-fix-arguments": options.fixArguments = false; break;
      case "-h": case "--help": options.help = true; break;
      case "-v": case "--version": options.version = true; break;
      default:
        if (arg.startsWith("-")) throw new Error("unknown option " + arg);
        rest.push(arg);
    }
  }
  if (options.command === undefined) options.command = rest.shift();
  if (options.target === undefined) options.target = rest.shift();
  return options;
}

function print(view, options) {
  if (options.json) process.stdout.write(JSON.stringify(view, null, 2) + "\n");
  else process.stdout.write(view.text + "\n");
}

function artifactPath(options) {
  const dshHome = resolveDshHome(options.dshHome);
  const target = options.dir ?? options.target;
  const resolved = resolveTarget(target, dshHome);
  return { dshHome, resolved };
}

function readArtifact(path) {
  const buffer = readFileSync(path);
  const text = decodeLog(buffer);
  const firstFrame = decodeFirstFrame(buffer);
  return { buffer, text, firstFrame };
}

function headerOf(text) {
  const { rows } = parseLog(text);
  return rows[0];
}

function describeScan(scan) {
  const lines = [];
  lines.push("行数               : " + scan.rows);
  lines.push("阻塞迁移的缺陷     : " + scan.blocking);
  for (const [key, value] of Object.entries(scan.counts)) {
    if (value > 0) lines.push("  - " + key.padEnd(28) + ": " + value);
  }
  lines.push("工具链             : advertised=" + scan.toolChains.advertised + " calls=" + scan.toolChains.calls + " results=" + scan.toolChains.results);
  if (scan.replacementCharacters > 0) lines.push("替换字符(U+FFFD)   : " + scan.replacementCharacters);
  return lines.join("\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question + " [y/N] ", resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function commandList(options) {
  const dshHome = resolveDshHome(options.dshHome);
  const sessions = listSessions(dshHome);
  const view = {
    dshHome,
    count: sessions.length,
    sessions: sessions.map((session) => ({
      id: session.id,
      project: session.project,
      generation: session.generation,
      quarantined: session.quarantined.length,
      path: session.path,
    })),
  };
  const text = [`DSH 主目录: ${dshHome}`, `会话数: ${sessions.length}`, ""]
    .concat(sessions.map((session) => "  " + session.id.padEnd(46) + " " + session.generation.padEnd(4) + " " + session.project + (session.quarantined.length ? "  [隔离 " + session.quarantined.length + "]" : "")))
    .join("\n");
  print({ ...view, text }, options);
  return 0;
}

async function commandScan(options) {
  const { resolved } = artifactPath(options);
  const { text, firstFrame } = readArtifact(resolved.path);
  const { rows } = parseLog(text);
  const scan = scanLog(rows, { text });
  const headerLineCount = firstFrame.split("\n").filter(Boolean).length;
  const view = {
    sessionId: resolved.id,
    path: resolved.path,
    header: { version: rows[0]?.version, cwd: rows[0]?.cwd, firstFrameLines: headerLineCount },
    scan,
  };
  const body = [
    `会话: ${resolved.id}`,
    `路径: ${resolved.path}`,
    `首帧行数: ${headerLineCount}（DSH 要求 = 1）`,
    "",
    describeScan(scan),
  ].join("\n");
  print({ ...view, text: body }, options);
  return scan.blocking > 0 ? 3 : 0;
}

async function commandValidate(options) {
  const { resolved } = artifactPath(options);
  const { text } = readArtifact(resolved.path);
  const result = await validateMigrationChain(text, { dshRoot: options.dshRoot });
  const view = { sessionId: resolved.id, path: resolved.path, ...result };
  const body = result.ok
    ? `迁移链校验通过 ✅  v3 事件数=${result.events}\n（使用 ${result.catalogPath}）`
    : result.skipped
      ? `跳过校验：${result.skipped}`
      : `迁移链校验失败 ❌\n${result.error}\n（使用 ${result.catalogPath}）`;
  print({ ...view, text: body }, options);
  return result.ok ? 0 : 2;
}

async function commandFix(options) {
  const { dshHome, resolved } = artifactPath(options);
  const path = resolved.path;
  if (basename(path) !== V0_ARTIFACT && options.dir === undefined) {
    // 允许对任意路径操作，但只有当活动工件是 v0 时才需要该修复
  }
  const { buffer, text } = readArtifact(path);
  const header = headerOf(text);
  if (header?.version !== 0 && options.json !== true) {
    process.stderr.write("提示: 该工件的 header version = " + String(header?.version) + "，本工具面向 format v0 日志。\n");
  }
  const { rows } = parseLog(text);
  const before = scanLog(rows, { text });
  const repaired = repairLogText(text, { fixArguments: options.fixArguments });
  const changedLines = repaired.changedLines;
  const validation = options.dryRun || options.validate === false ? undefined : await validateMigrationChain(repaired.text, { dshRoot: options.dshRoot });

  const summary = {
    sessionId: resolved.id,
    path,
    dryRun: options.dryRun === true,
    before: before.counts,
    after: repaired.after.counts,
    stats: repaired.stats,
    changedLines: changedLines.length,
    skipped: repaired.skipped,
    validation,
  };

  if (changedLines.length === 0) {
    const body = "无需修复：未发现本工具可处理的缺陷。\n" + describeScan(before);
    print({ ...summary, text: body }, options);
    return before.blocking > 0 ? 3 : 0;
  }

  if (options.dryRun) {
    const body = [
      `[dry-run] 将修改 ${changedLines.length} 行: ${changedLines.slice(0, 40).join(", ")}${changedLines.length > 40 ? " …" : ""}`,
      JSON.stringify(repaired.stats, null, 2),
      validation ? (validation.ok ? "迁移链预校验: 通过 ✅" : "迁移链预校验: 仍失败 ❌ " + validation.error) : "",
    ].filter(Boolean).join("\n");
    print({ ...summary, text: body }, options);
    return validation === undefined || validation.ok ? 0 : 2;
  }

  if (!options.yes && !(await confirm("将备份并改写 " + path + "，继续？"))) {
    process.stderr.write("已取消（未改动任何文件）。\n");
    return 1;
  }
  if (validation !== undefined && validation.ok === false && validation.skipped === undefined) {
    process.stderr.write("拒绝写入：修复后的日志仍无法通过迁移链校验。\n" + validation.error + "\n");
  }

  const backupPath = backupArtifact({ dshHome, source: path, sessionId: resolved.id, tag: "pre-repair" });
  const encoded = encodeLog(repaired.text.split("\n").slice(0, -1));
  const temp = path + ".tmp-" + process.pid;
  writeFileSync(temp, encoded);
  renameSync(temp, path);
  writeAudit({
    dshHome,
    entry: {
      at: new Date().toISOString(),
      sessionId: resolved.id,
      path,
      backup: backupPath,
      bytesBefore: buffer.length,
      bytesAfter: encoded.length,
      changedLines: changedLines.length,
      stats: repaired.stats,
      validation: validation === undefined ? null : validation.ok,
      tool: NAME,
      version: VERSION,
    },
  });

  const body = [
    `已修复 ${resolved.id}`,
    `  备份      : ${backupPath}`,
    `  改动行数  : ${changedLines.length}（${changedLines.slice(0, 20).join(", ")}${changedLines.length > 20 ? " …" : ""}）`,
    `  体积      : ${buffer.length} → ${encoded.length} 字节`,
    `  修复统计  : ${JSON.stringify(repaired.stats)}`,
    `  迁移链    : ${validation === undefined ? "未校验" : validation.ok ? "通过 ✅ (" + validation.events + " 个 v3 事件)" : "失败 ❌ " + validation.error}`,
    `  审计目录  : ${join(repairRoot(dshHome), "audit")}`,
  ].join("\n");
  print({ ...summary, backupPath, text: body }, options);
  return validation === undefined || validation.ok ? 0 : 2;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n\n" + HELP);
    return 1;
  }
  if (options.version) { process.stdout.write(VERSION + "\n"); return 0; }
  if (options.help || options.command === undefined) { process.stdout.write(HELP); return options.command === undefined && !options.help ? 1 : 0; }
  try {
    switch (options.command) {
      case "list": return await commandList(options);
      case "scan": return await commandScan(options);
      case "fix": return await commandFix(options);
      case "validate": return await commandValidate(options);
      default:
        process.stderr.write("未知命令: " + options.command + "\n\n" + HELP);
        return 1;
    }
  } catch (error) {
    process.stderr.write("错误: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}

process.exitCode = await main();
