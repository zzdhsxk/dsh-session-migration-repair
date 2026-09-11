/**
 * Offline verification against the host's real migration chain.
 *
 * DSH ships the whole load path as the `sessionFormatCatalog` service: it
 * decodes physical rows, runs v0 → v1 → v2 → v3, and validates the installed
 * current-generation artifact. Driving it locally reproduces exactly what the
 * running server would do when the session is opened — no need to restart the
 * server and click around to find out whether a repair worked.
 *
 * @module dsh-session-migration-repair/core/chain-validate
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseLog } from "./log.mjs";

const CATALOG_SUBPATH = "node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js";

/**
 * Candidate DSH installation roots.
 * @param {{dshRoot?: string, env?: Record<string, string | undefined>}} [options]
 */
export function catalogCandidates(options = {}) {
  const env = options.env ?? process.env;
  const candidates = [];
  if (options.dshRoot !== undefined) candidates.push(options.dshRoot);
  if (env.DSH_INSTALL !== undefined) candidates.push(env.DSH_INSTALL);
  if (env.DSH_ROOT !== undefined) candidates.push(env.DSH_ROOT);
  candidates.push("/opt/homebrew/lib/node_modules/@deepseek-ai/dsh");
  candidates.push("/usr/local/lib/node_modules/@deepseek-ai/dsh");
  candidates.push("/usr/lib/node_modules/@deepseek-ai/dsh");
  if (env.HOME !== undefined) {
    candidates.push(join(env.HOME, ".npm-global/lib/node_modules/@deepseek-ai/dsh"));
    candidates.push(join(env.HOME, "node_modules/@deepseek-ai/dsh"));
  }
  // 也可以直接从当前进程的解析路径得到（例如插件运行在 dsh 进程内时）
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@deepseek-ai/dsh-session-format-catalog");
    candidates.unshift(entry.replace(/\/node_modules\/@deepseek-ai\/dsh-session-format-catalog\/.*$/, ""));
  } catch {
    /* not resolvable from here — filesystem candidates remain */
  }
  return [...new Set(candidates)];
}

/**
 * Load the format catalog, or return undefined when no DSH install is found.
 * @param {{dshRoot?: string, env?: Record<string, string | undefined>}} [options]
 */
export async function loadCatalog(options = {}) {
  const roots = options.roots ?? catalogCandidates(options);
  for (const root of roots) {
    const path = join(root, CATALOG_SUBPATH);
    if (!existsSync(path)) continue;
    try {
      const module = await import(path);
      return { catalog: module.sessionFormatCatalog, catalogPath: path };
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/**
 * Run one decompressed log through the real migration chain.
 * @param {string} text
 * @param {{catalog?: any, dshRoot?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {Promise<{ok: boolean, events?: number, error?: string, skipped?: string, catalogPath?: string}>}
 */
export async function validateMigrationChain(text, options = {}) {
  if (options.catalog === false) return { ok: false, skipped: "format catalog explicitly disabled" };
  const loaded = options.catalog !== undefined ? { catalog: options.catalog, catalogPath: "(provided)" } : await loadCatalog(options);
  if (loaded === undefined) return { ok: false, skipped: "no DSH install found (set DSH_INSTALL or --dsh-root)" };
  const { catalog, catalogPath } = loaded;
  let header;
  try {
    const { rows, lines } = parseLog(text);
    header = rows[0];
    if (header === undefined || header === null || lines.length === 0) return { ok: false, error: "log has no parsable header line", catalogPath };
    const restore = catalog.createRestore(header, { validation: "current" });
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      restore.decoder.decodeRow(row, restore.migration);
    }
    restore.migration.finish();
    const artifact = restore.restoreArtifact({
      header: restore.header,
      events: restore.collector.values,
      inheritedEventCount: restore.sourceInheritedEventCount,
    });
    const events = Array.isArray(artifact?.events) ? artifact.events.length : restore.collector.values.length;
    return { ok: true, events, catalogPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), catalogPath };
  }
}
