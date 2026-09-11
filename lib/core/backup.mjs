/**
 * Pre-repair backups and an append-only audit trail.
 * @module dsh-session-migration-repair/core/backup
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Root of this plugin's own data. */
export function repairRoot(dshHome) {
  return join(dshHome, "session-migration-repair");
}

/** Timestamp suitable for file names. */
export function stamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * Copy one artifact into the plugin's backup area before it is rewritten.
 * @param {{dshHome: string, source: string, sessionId: string, tag?: string}} options
 * @returns {string} the backup path
 */
export function backupArtifact(options) {
  const { dshHome, source, sessionId } = options;
  const tag = options.tag ?? "pre-repair";
  const dir = join(repairRoot(dshHome), "backups", stamp());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, sessionId + "." + tag + ".jsonl.zstd");
  copyFileSync(source, target);
  return target;
}

/**
 * Append one JSON line to the plugin's audit ledger.
 * @param {{dshHome: string, entry: Record<string, unknown>}} options
 */
export function writeAudit(options) {
  const dir = join(repairRoot(options.dshHome), "audit");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "repair-log.jsonl"), JSON.stringify(options.entry) + "\n", { flag: "a" });
}
