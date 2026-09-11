/**
 * The migration-repair engine.
 *
 * DSH 0.1.5+ migrates stored format-v0 logs through v1 → v2 → v3 and validates
 * every step. Legacy logs (written by older builds, sometimes rewritten by
 * earlier repair tooling) can violate those checks in ways the writing build
 * never noticed:
 *
 *  - `tool-call-chunks` rows whose `id` is empty (only the first row of a
 *    streamed call used to carry it) — v0→v1 refuses them.
 *  - `assistant/message` tool-call blocks whose `name`/`id` is empty —
 *    v0→v1 refuses them.
 *  - `assistant/chunk` `block-end` tool-call blocks whose `id` is empty —
 *    v2→v3 validates them through a probe and refuses them.
 *  - `tool/call` rows whose `name` is empty or whose `arguments` no longer
 *    match the advertised call — v0→v1 refuses the mismatch.
 *
 * The missing values are recoverable from the surrounding stream: every tool
 * call is announced by an `assistant/chunk` `tool-call-delta` carrying the
 * real id and tool name.
 *
 * @module dsh-session-migration-repair/core/migration-repair
 */
import { messageContent, parseLog, serializeLog } from "./log.mjs";

const REPLACEMENT = "\uFFFD";

/** @typedef {{line: number} & Record<string, unknown>} Sample */

function push(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Index the call-related information of one log.
 * @param {any[]} rows
 */
export function indexLog(rows) {
  /** tool name by `turn|step` (first non-empty wins) */
  const nameByStep = new Map();
  /** tool-call-delta by `turn|step|index` (first non-empty id wins) */
  const deltaByIndex = new Map();
  /** every non-empty delta id for one `turn|step` */
  const deltasByStep = new Map();
  /** advertised call (assistant/message content block) by call id */
  const advertisedByCall = new Map();
  /** tool/call data by call id (last wins, matching how the log is replayed) */
  const callByCall = new Map();
  /** call ids that produced a tool/result */
  const results = new Set();

  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    if (row.type === "assistant/chunk") {
      const chunk = data.chunk ?? {};
      if (chunk.type !== "tool-call-delta") continue;
      const stepKey = data.turn + "|" + data.step;
      const indexKey = stepKey + "|" + chunk.index;
      if (typeof chunk.name === "string" && chunk.name.length > 0 && !nameByStep.has(stepKey)) nameByStep.set(stepKey, chunk.name);
      if (typeof chunk.id === "string" && chunk.id.length > 0) {
        if (!deltaByIndex.has(indexKey)) deltaByIndex.set(indexKey, { id: chunk.id, name: chunk.name, index: chunk.index, turn: data.turn, step: data.step });
        push(deltasByStep, stepKey, { id: chunk.id, name: chunk.name, index: chunk.index });
      }
    } else if (row.type === "assistant/message") {
      const content = messageContent(row);
      if (content === undefined) continue;
      for (const block of content) {
        if (block?.type === "tool-call" && typeof block.id === "string" && block.id.length > 0) {
          if (!advertisedByCall.has(block.id)) advertisedByCall.set(block.id, { block, line, turn: data.turn, step: data.step });
        }
      }
    } else if (row.type === "tool/call") {
      if (typeof data.callId === "string" && data.callId.length > 0) callByCall.set(data.callId, { data, line, turn: data.turn, step: data.step });
    } else if (row.type === "tool/result") {
      const callId = data.message?.source?.callId;
      if (typeof callId === "string") results.add(callId);
    }
  }
  return { nameByStep, deltaByIndex, deltasByStep, advertisedByCall, callByCall, results };
}

/** Resolve the tool name for one `turn|step`. */
function nameFor(index, turn, step) {
  return index.nameByStep.get(turn + "|" + step);
}

/** Resolve a delta id for one `turn|step` (by chunk index when possible). */
function deltaFor(index, turn, step, chunkIndex) {
  const stepKey = turn + "|" + step;
  if (chunkIndex !== undefined) {
    const exact = index.deltaByIndex.get(stepKey + "|" + chunkIndex);
    if (exact !== undefined) return exact;
  }
  const list = index.deltasByStep.get(stepKey);
  if (list !== undefined && list.length === 1) return list[0];
  return undefined;
}

/**
 * Inspect one log and report every migration-blocking defect.
 * @param {any[]} rows parsed rows
 * @param {{text?: string}} [options]
 */
export function scanLog(rows, options = {}) {
  const index = indexLog(rows);
  const defects = {
    packedChunkMissingId: [],
    packedChunkShape: [],
    messageToolCallMissingId: [],
    messageToolCallMissingName: [],
    blockEndMissingId: [],
    blockEndMissingName: [],
    toolCallMissingName: [],
    toolCallArgumentMismatch: [],
    duplicateAdvertisedCall: [],
    toolCallWithoutAdvertisement: [],
    toolCallWithoutResult: [],
  };
  const seenAdvertised = new Set();

  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    const type = row.type;
    if (type === "tool-call-chunks") {
      if (typeof data.id !== "string" || data.id.length === 0) {
        defects.packedChunkMissingId.push({ line, turn: data.turn, step: data.step, index: data.index });
      }
      const payload = data.args;
      const gaps = data.dt;
      if (!Array.isArray(payload) || payload.length === 0 || payload.some((member) => typeof member !== "string") ||
          !Array.isArray(gaps) || gaps.length !== payload.length - 1 ||
          gaps.some((gap) => !Number.isSafeInteger(gap)) ||
          !Number.isSafeInteger(row.seq0) || !Number.isSafeInteger(row.time0)) {
        defects.packedChunkShape.push({ line, turn: data.turn, step: data.step, index: data.index });
      }
    } else if (type === "assistant/message") {
      const content = messageContent(row);
      if (content === undefined) continue;
      for (let position = 0; position < content.length; position += 1) {
        const block = content[position];
        if (block?.type !== "tool-call") continue;
        const label = { line, turn: data.turn, step: data.step, position };
        if (typeof block.id !== "string" || block.id.length === 0) defects.messageToolCallMissingId.push(label);
        else if (seenAdvertised.has(block.id)) defects.duplicateAdvertisedCall.push({ ...label, id: block.id });
        else seenAdvertised.add(block.id);
        if (typeof block.name !== "string" || block.name.length === 0) defects.messageToolCallMissingName.push(label);
      }
    } else if (type === "assistant/chunk") {
      const chunk = data.chunk ?? {};
      if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
        const label = { line, turn: data.turn, step: data.step, index: chunk.index };
        if (typeof chunk.block.id !== "string" || chunk.block.id.length === 0) defects.blockEndMissingId.push(label);
        if (typeof chunk.block.name !== "string" || chunk.block.name.length === 0) defects.blockEndMissingName.push(label);
      }
    } else if (type === "tool/call") {
      if (typeof data.name !== "string" || data.name.length === 0) {
        defects.toolCallMissingName.push({ line, callId: data.callId, turn: data.turn, step: data.step });
      }
      const advertised = index.advertisedByCall.get(data.callId);
      if (advertised === undefined) defects.toolCallWithoutAdvertisement.push({ line, callId: data.callId });
      else if (advertised.block.arguments !== data.arguments) {
        defects.toolCallArgumentMismatch.push({
          line,
          callId: data.callId,
          advertisedLine: advertised.line,
          advertisedBytes: typeof advertised.block.arguments === "string" ? advertised.block.arguments.length : -1,
          callBytes: typeof data.arguments === "string" ? data.arguments.length : -1,
          advertisedHasReplacement: typeof advertised.block.arguments === "string" && advertised.block.arguments.includes(REPLACEMENT),
          callHasReplacement: typeof data.arguments === "string" && data.arguments.includes(REPLACEMENT),
        });
      }
    }
  }

  for (const [id, advertised] of index.advertisedByCall) {
    if (!index.callByCall.has(id)) defects.toolCallWithoutAdvertisement.push({ line: advertised.line, callId: id, advertised: true });
    else if (!index.results.has(id)) defects.toolCallWithoutResult.push({ line: advertised.line, callId: id });
  }

  const counts = Object.fromEntries(Object.entries(defects).map(([key, list]) => [key, list.length]));
  const text = options.text ?? "";
  const report = {
    rows: rows.length,
    counts,
    blocking: counts.packedChunkMissingId + counts.packedChunkShape + counts.messageToolCallMissingId +
      counts.messageToolCallMissingName + counts.blockEndMissingId + counts.blockEndMissingName +
      counts.toolCallMissingName + counts.toolCallArgumentMismatch + counts.duplicateAdvertisedCall,
    defects,
    toolChains: {
      advertised: index.advertisedByCall.size,
      calls: index.callByCall.size,
      results: index.results.size,
    },
    replacementCharacters: text.split(REPLACEMENT).length - 1,
  };
  return report;
}

/**
 * Repair a log in memory.
 *
 * Only the lines that actually change are re-serialized, which keeps the diff
 * against the original artifact minimal and reviewable.
 *
 * @param {any[]} rows
 * @param {{fixArguments?: boolean}} [options]
 * @returns {{changedLines: number[], stats: Record<string, number>, skipped: Sample[]}}
 */
export function planRepair(rows, options = {}) {
  const fixArguments = options.fixArguments !== false;
  const index = indexLog(rows);
  const stats = {
    packedChunkIdFilled: 0,
    packedChunkNameFilled: 0,
    messageToolCallIdFilled: 0,
    messageToolCallNameFilled: 0,
    blockEndIdFilled: 0,
    blockEndNameFilled: 0,
    toolCallNameFilled: 0,
    toolCallArgumentsAligned: 0,
    toolCallArgumentsLeftAlone: 0,
  };
  const changed = new Set();
  const skipped = [];

  if (fixArguments) {
    for (const [callId, advertised] of index.advertisedByCall) {
      const call = index.callByCall.get(callId);
      if (call === undefined) continue;
      const advertisedArgs = advertised.block.arguments;
      const callArgs = call.data.arguments;
      if (typeof advertisedArgs !== "string" || typeof callArgs !== "string" || advertisedArgs === callArgs) continue;
      // 一侧被早期工具写坏（出现替换字符）时以干净的一侧为准，否则保留消息里对外声明的那份。
      const advertisedDirty = advertisedArgs.includes(REPLACEMENT);
      const callDirty = callArgs.includes(REPLACEMENT);
      const winner = advertisedDirty && !callDirty ? callArgs : advertisedArgs;
      if (advertised.block.arguments !== winner) { advertised.block.arguments = winner; changed.add(advertised.line); }
      if (call.data.arguments !== winner) { call.data.arguments = winner; changed.add(call.line); }
      stats.toolCallArgumentsAligned += 1;
    }
  } else {
    stats.toolCallArgumentsLeftAlone = index.advertisedByCall.size;
  }

  for (let line = 1; line <= rows.length; line += 1) {
    const row = rows[line - 1];
    if (row === undefined || row === null) continue;
    const data = row.data ?? {};
    const type = row.type;
    let dirty = false;

    if (type === "tool-call-chunks") {
      if (typeof data.id !== "string" || data.id.length === 0) {
        const delta = deltaFor(index, data.turn, data.step, data.index);
        if (delta !== undefined) {
          data.id = delta.id;
          stats.packedChunkIdFilled += 1;
          dirty = true;
          if (typeof delta.name === "string" && delta.name.length > 0) { data.name = delta.name; stats.packedChunkNameFilled += 1; }
          else if (data.name !== undefined) delete data.name;
        } else {
          skipped.push({ line, kind: "packedChunkMissingId", reason: "no tool-call-delta announces this streamed call" });
        }
      } else if (data.name === "" || (data.name !== undefined && typeof data.name !== "string")) {
        delete data.name;
        dirty = true;
      }
    } else if (type === "assistant/message") {
      const content = messageContent(row);
      if (content !== undefined) {
        const name = nameFor(index, data.turn, data.step);
        for (let position = 0; position < content.length; position += 1) {
          const block = content[position];
          if (block?.type !== "tool-call") continue;
          if ((typeof block.name !== "string" || block.name.length === 0) && name !== undefined) {
            block.name = name;
            stats.messageToolCallNameFilled += 1;
            dirty = true;
          }
          if (typeof block.id !== "string" || block.id.length === 0) {
            const delta = deltaFor(index, data.turn, data.step, position);
            if (delta !== undefined) { block.id = delta.id; stats.messageToolCallIdFilled += 1; dirty = true; }
            else skipped.push({ line, kind: "messageToolCallMissingId", reason: "no delta for content block " + position });
          }
        }
      }
    } else if (type === "assistant/chunk") {
      const chunk = data.chunk ?? {};
      if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
        const name = nameFor(index, data.turn, data.step);
        if ((typeof chunk.block.name !== "string" || chunk.block.name.length === 0) && name !== undefined) {
          chunk.block.name = name;
          stats.blockEndNameFilled += 1;
          dirty = true;
        }
        if (typeof chunk.block.id !== "string" || chunk.block.id.length === 0) {
          const delta = deltaFor(index, data.turn, data.step, chunk.index);
          if (delta !== undefined) { chunk.block.id = delta.id; stats.blockEndIdFilled += 1; dirty = true; }
          else skipped.push({ line, kind: "blockEndMissingId", reason: "no delta for block index " + String(chunk.index) });
        }
      }
    } else if (type === "tool/call") {
      const name = nameFor(index, data.turn, data.step);
      if ((typeof data.name !== "string" || data.name.length === 0) && name !== undefined) {
        data.name = name;
        stats.toolCallNameFilled += 1;
        dirty = true;
      }
    }
    if (dirty) changed.add(line);
  }

  return { changedLines: [...changed].sort((a, b) => a - b), stats, skipped };
}

/**
 * Convenience wrapper: scan + repair one decompressed log text.
 * @param {string} text
 * @param {{fixArguments?: boolean}} [options]
 */
export function repairLogText(text, options = {}) {
  const { lines, rows, invalid } = parseLog(text);
  const before = scanLog(rows, { text });
  const plan = planRepair(rows, options);
  for (const line of plan.changedLines) {
    if (rows[line - 1] !== undefined) lines[line - 1] = JSON.stringify(rows[line - 1]);
  }
  const after = scanLog(rows, { text: serializeLog(lines) });
  return {
    text: serializeLog(lines),
    before,
    after,
    changedLines: plan.changedLines,
    stats: plan.stats,
    invalidLines: invalid,
    skipped: plan.skipped,
  };
}
