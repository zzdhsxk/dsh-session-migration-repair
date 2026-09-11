/**
 * dsh-session-migration-repair — DSH host plugin.
 *
 * Registers one model-callable tool (and a bundled skill) that diagnoses and
 * repairs legacy format-v0 session logs which the current build refuses to
 * migrate, then verifies the result against the host's own migration chain.
 *
 * @module dsh-session-migration-repair
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupArtifact, repairRoot, writeAudit } from "./core/backup.mjs";
import { validateMigrationChain } from "./core/chain-validate.mjs";
import { listSessions, resolveDshHome, resolveTarget } from "./core/locate.mjs";
import { parseLog } from "./core/log.mjs";
import { repairLogText, scanLog } from "./core/migration-repair.mjs";
import { decodeLog, encodeLog } from "./core/zstd.mjs";

export const name = "dsh-session-migration-repair";
/** Optional services are resolved through ctx.get, so a missing capability degrades gracefully. */
export const inject = [];

const VERSION = "0.1.0";

function dshHomeOf(ctx) {
  const fromContext = ctx.get("dshHome");
  if (typeof fromContext === "string" && fromContext.length > 0) return fromContext;
  return resolveDshHome();
}

async function pathOf(ctx, sessionId, explicitPath, dshHome) {
  if (typeof explicitPath === "string" && explicitPath.length > 0) return explicitPath;
  const persistence = ctx.get("sessionPersistence");
  if (persistence?.list !== undefined && persistence?.locate !== undefined) {
    try {
      const headers = await persistence.list();
      const header = headers.find((candidate) => String(candidate.id) === sessionId);
      if (header !== undefined) {
        const location = persistence.locate(header);
        if (typeof location?.path === "string") return location.path;
      }
    } catch {
      /* fall through to the filesystem lookup */
    }
  }
  return resolveTarget(sessionId, dshHome).path;
}

function readTarget(text) {
  const { rows } = parseLog(text);
  return rows;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const dshHome = dshHomeOf(ctx);

  let disposeSkill = () => {};
  const skills = ctx.get("skills");
  if (skills?.register !== undefined) {
    const self = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
    const skillPath = join(self, "..", "skills", "dsh-session-migration-repair", "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf8");
      disposeSkill = skills.register({
        name: "dsh-session-migration-repair",
        description: "Diagnose and repair legacy DSH session logs (format v0) that fail migration to the current format.",
        whenToUse: "a stored session fails to load with a SessionFormatError / 'refuses this format v0 Session' / 'history unavailable'",
        invocation: { modelInvocable: true, userInvocable: true },
        source: "bundled",
        provider: name,
        resourceBase: { kind: "directory", path: join(skillPath, "..") },
        path: skillPath,
        content,
      });
    } catch (error) {
      ctx.logger?.warn?.("dsh-session-migration-repair: skill unavailable: " + String(error));
    }
  }

  let disposeTool = () => {};
  const tools = ctx.get("tools");
  if (tools?.register !== undefined) {
    disposeTool = tools.register({
      name: "dsh_session_migration_repair",
      description:
        "Diagnose or repair a stored DSH session log that the current build refuses to migrate " +
        "(legacy format v0 → v3). Actions: scan (read-only), fix (backup + repair + verify), validate (run the real migration chain offline).",
      parameters: {
        action: { type: "string", required: false, description: "scan | fix | validate (default scan)" },
        sessionId: { type: "string", required: false, description: "stored session id; defaults to the current session" },
        path: { type: "string", required: false, description: "explicit artifact path (overrides sessionId)" },
        dryRun: { type: "boolean", required: false, description: "for fix: report the planned change without writing" },
        fixArguments: { type: "boolean", required: false, description: "for fix: also align tool/call arguments (default true)" },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const action = typeof args?.action === "string" ? args.action : "scan";
        const sessionId = args?.sessionId ?? exec?.agent?.session?.id;
        if (sessionId === undefined && args?.path === undefined) throw new Error("sessionId or path is required");
        const path = await pathOf(ctx, sessionId, args?.path, dshHome);
        const buffer = readFileSync(path);
        const text = decodeLog(buffer);
        const rows = readTarget(text);
        const report = {
          sessionId,
          path,
          action,
          version: VERSION,
        };

        if (action === "validate") {
          const validation = await validateMigrationChain(text, {});
          report.validation = validation;
          report.text = validation.ok
            ? "迁移链校验通过 ✅ v3 事件数=" + validation.events
            : validation.skipped
              ? "跳过校验：" + validation.skipped
              : "迁移链校验失败 ❌\n" + validation.error;
          return report;
        }

        const before = scanLog(rows, { text });
        report.scan = { counts: before.counts, blocking: before.blocking, toolChains: before.toolChains };
        if (action === "scan") {
          report.text = "会话 " + String(sessionId) + "\n阻塞迁移的缺陷: " + before.blocking + "\n" + JSON.stringify(before.counts, null, 2);
          return report;
        }
        if (action !== "fix") throw new Error("unknown action " + JSON.stringify(action));

        const repaired = repairLogText(text, { fixArguments: args?.fixArguments !== false });
        report.repair = { changedLines: repaired.changedLines.length, lines: repaired.changedLines.slice(0, 50), stats: repaired.stats, skipped: repaired.skipped };
        const validation = await validateMigrationChain(repaired.text, {});
        report.validation = validation;

        if (args?.dryRun === true || repaired.changedLines.length === 0) {
          report.dryRun = true;
          report.text = "dry-run：将修改 " + repaired.changedLines.length + " 行；迁移链预校验=" + (validation.ok ? "通过 ✅" : "失败 ❌ " + validation.error);
          return report;
        }

        const backupPath = backupArtifact({ dshHome, source: path, sessionId: String(sessionId), tag: "pre-repair" });
        const encoded = encodeLog(repaired.text.split("\n").slice(0, -1));
        const temp = path + ".tmp-" + process.pid;
        writeFileSync(temp, encoded);
        renameSync(temp, path);
        writeAudit({
          dshHome,
          entry: {
            at: new Date().toISOString(),
            sessionId,
            path,
            backup: backupPath,
            bytesBefore: buffer.length,
            bytesAfter: encoded.length,
            changedLines: repaired.changedLines.length,
            stats: repaired.stats,
            validation: validation.ok,
            tool: name,
            version: VERSION,
          },
        });
        report.backupPath = backupPath;
        report.after = repaired.after.counts;
        report.text = [
          "已修复 " + String(sessionId),
          "  备份    : " + backupPath,
          "  改动行数: " + repaired.changedLines.length,
          "  迁移链  : " + (validation.ok ? "通过 ✅ (" + validation.events + " 个 v3 事件)" : "失败 ❌ " + validation.error),
          "  审计目录: " + join(repairRoot(dshHome), "audit"),
        ].join("\n");
        return report;
      },
    });
    ctx.effect(() => disposeTool, "dsh-session-migration-repair tool");
  }

  ctx.logger?.info?.("dsh-session-migration-repair mounted (dshHome=" + dshHome + ")");
  return () => {
    disposeTool();
    disposeSkill();
  };
}
