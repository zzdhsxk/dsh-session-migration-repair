/**
 * Locating DSH session artifacts on disk.
 * @module dsh-session-migration-repair/core/locate
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the DSH home directory (`$DSH_HOME` wins). */
export function resolveDshHome(explicit) {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.DSH_HOME;
  if (env !== undefined && env !== "") return env;
  return join(homedir(), ".dsh");
}

/** Name of the artifact holding the active (highest) generation of a session. */
export const V0_ARTIFACT = "session.jsonl.zstd";
export const V3_ARTIFACT = "session.v3.jsonl.zstd";

/**
 * List every stored session directory.
 * @param {string} dshHome
 */
export function listSessions(dshHome) {
  const root = join(dshHome, "sessions");
  const found = [];
  let projects;
  try { projects = readdirSync(root); } catch { return found; }
  for (const project of projects) {
    let entries;
    try { entries = readdirSync(join(root, project)); } catch { continue; }
    for (const id of entries) {
      const dir = join(root, project, id);
      let stat;
      try { stat = statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files = [];
      try { files = readdirSync(dir); } catch { /* unreadable */ }
      const hasV3 = files.includes(V3_ARTIFACT);
      const hasV0 = files.includes(V0_ARTIFACT);
      found.push({
        id,
        project,
        dir,
        path: join(dir, hasV3 ? V3_ARTIFACT : V0_ARTIFACT),
        generation: hasV3 ? "v3" : hasV0 ? "v0" : "none",
        quarantined: files.filter((name) => name.includes(".corrupt-")),
      });
    }
  }
  return found;
}

/**
 * Resolve a CLI argument (session id or direct path) to a concrete artifact.
 * @param {string} target
 * @param {string} dshHome
 */
export function resolveTarget(target, dshHome) {
  if (target === undefined || target === "") throw new Error("a session id or artifact path is required");
  if (target.includes("/") || target.endsWith(".zstd")) {
    const stat = statSync(target);
    if (stat.isDirectory()) return { id: target.split("/").filter(Boolean).pop(), path: join(target, V3_ARTIFACT), dir: target };
    return { id: target.split("/").filter(Boolean).slice(-2)[0] ?? "unknown", path: target, dir: target.replace(/\/[^/]+$/, "") };
  }
  const match = listSessions(dshHome).find((session) => session.id === target);
  if (match === undefined) throw new Error("no stored session matches id " + JSON.stringify(target));
  return { id: match.id, path: match.path, dir: match.dir, generation: match.generation, project: match.project };
}
