import assert from "node:assert/strict";
import test from "node:test";
import { parseLog } from "../lib/core/log.mjs";
import { planRepair, repairLogText, scanLog } from "../lib/core/migration-repair.mjs";
import { defectiveLog } from "./fixtures.mjs";

test("scanLog 能识别四类缺陷", () => {
  const { rows } = parseLog(defectiveLog());
  const scan = scanLog(rows, { text: defectiveLog() });
  assert.equal(scan.counts.packedChunkMissingId, 1, "分片行空 id");
  assert.equal(scan.counts.blockEndMissingId, 1, "block-end 空 id");
  assert.equal(scan.counts.blockEndMissingName, 1, "block-end 空 name");
  assert.equal(scan.counts.messageToolCallMissingName, 1, "消息块空 name");
  assert.equal(scan.counts.toolCallMissingName, 1, "tool/call 空 name");
  assert.equal(scan.counts.toolCallArgumentMismatch, 1, "arguments 不一致");
  assert.equal(scan.counts.duplicateAdvertisedCall, 0);
  assert.ok(scan.blocking >= 5);
});

test("repairLogText 修好全部缺陷，且只改必要行", () => {
  const repaired = repairLogText(defectiveLog());
  assert.equal(repaired.after.blocking, 0, "修复后不应再有阻塞缺陷: " + JSON.stringify(repaired.after.counts));
  assert.equal(repaired.after.counts.toolCallArgumentMismatch, 0, "arguments 应对齐");
  assert.equal(repaired.stats.packedChunkIdFilled, 1);
  assert.equal(repaired.stats.blockEndIdFilled, 1);
  assert.equal(repaired.stats.blockEndNameFilled, 1);
  assert.equal(repaired.stats.messageToolCallNameFilled, 1);
  assert.equal(repaired.stats.toolCallNameFilled, 1);
  assert.ok(repaired.changedLines.length <= 6, "只重写必要的行，实际: " + repaired.changedLines.join(","));
  assert.equal(repaired.invalidLines.length, 0);
});

test("修复保留 header 与无关行原样", () => {
  const original = defectiveLog().split("\n");
  const repaired = repairLogText(defectiveLog()).text.split("\n");
  assert.equal(repaired[0], original[0], "header 不变");
  assert.equal(repaired[6], original[6], "无关行不变");
  assert.equal(repaired.length, original.length, "行数不变");
});

test("planRepair 可关闭 arguments 对齐", () => {
  const { rows } = parseLog(defectiveLog());
  const plan = planRepair(rows, { fixArguments: false });
  assert.equal(plan.stats.toolCallArgumentsAligned, 0);
  assert.ok(plan.stats.toolCallArgumentsLeftAlone > 0);
  assert.equal(plan.stats.messageToolCallNameFilled, 1, "其它修复不受影响");
});

test("无法解析的行被报告而不是抛错", () => {
  const { rows, invalid } = parseLog("{\"type\":\"session\",\"version\":0}\n{oops\n");
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].line, 2);
  assert.equal(rows[1], undefined);
});
