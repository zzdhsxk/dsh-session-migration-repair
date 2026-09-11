import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog, validateMigrationChain } from "../lib/core/chain-validate.mjs";
import { defectiveLog } from "./fixtures.mjs";

test("显式给出不存在的安装根时返回 skipped，而不是抛错", async () => {
  const result = await validateMigrationChain(defectiveLog(), { roots: [] });
  assert.equal(result.ok, false);
  assert.match(String(result.skipped), /no DSH install found/);
});

test("catalog 可显式关闭（用于离线环境）", async () => {
  const result = await validateMigrationChain(defectiveLog(), { catalog: false });
  assert.equal(result.ok, false);
  assert.match(String(result.skipped), /explicitly disabled/);
});

test("能找到宿主 DSH 时，缺陷日志会被真实迁移链拒绝", async (t) => {
  const loaded = await loadCatalog();
  if (loaded === undefined) {
    t.skip("本机未找到 DSH 安装，跳过真实迁移链用例");
    return;
  }
  const result = await validateMigrationChain(defectiveLog(), { catalog: loaded.catalog });
  assert.equal(result.ok, false, "带缺陷的日志不应通过迁移链");
  assert.ok(String(result.error ?? "").length > 0, "应给出可读的错误信息");
});

test("真实会话日志的回归用例（需设置 DSH_REAL_V0_LOG）", async (t) => {
  const path = process.env.DSH_REAL_V0_LOG;
  if (path === undefined || path === "") {
    t.skip("未设置 DSH_REAL_V0_LOG，跳过真实日志用例");
    return;
  }
  const { readFileSync } = await import("node:fs");
  const { decodeLog } = await import("../lib/core/zstd.mjs");
  const { repairLogText } = await import("../lib/core/migration-repair.mjs");
  const text = decodeLog(readFileSync(path));
  const repaired = repairLogText(text);
  assert.equal(repaired.after.blocking, 0, "真实日志修复后不应有阻塞缺陷");
  const result = await validateMigrationChain(repaired.text, {});
  assert.equal(result.ok, true, "真实日志修复后应通过迁移链: " + String(result.error));
});
