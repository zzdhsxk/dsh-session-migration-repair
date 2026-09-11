import assert from "node:assert/strict";
import test from "node:test";
import { decodeFirstFrame, decodeLog, decompressFrames, encodeLog, listFrames } from "../lib/core/zstd.mjs";

const SAMPLE = ["{\"type\":\"session\",\"version\":0,\"id\":\"x\"}", "{\"a\":1}", "{\"b\":2}", "{\"c\":3}"];

test("encodeLog 产出多帧，且首帧只含 header 一行", () => {
  const buffer = encodeLog(SAMPLE, { frameLines: 2 });
  const frames = listFrames(buffer);
  assert.equal(frames.length, 3, "1 header frame + 2 data frames");
  assert.equal(decodeFirstFrame(buffer), SAMPLE[0] + "\n", "first frame must be exactly the header line");
  assert.equal(decodeLog(buffer), SAMPLE.join("\n") + "\n");
});

test("多字节字符往返不损坏（块边界也不受影响）", () => {
  const lines = ["{\"type\":\"session\"}", "{\"text\":\"达哥的仙途：修仙文字游戏🎮\"}", "{\"text\":\"第二行中文——破折号、emoji 🚀 与标点「」\"}"];
  const buffer = encodeLog(lines, { frameLines: 1 });
  const text = decodeLog(buffer);
  assert.equal(text, lines.join("\n") + "\n");
  assert.equal(text.includes("\uFFFD"), false, "no replacement characters may appear");
});

test("decompressFrames 拼接全部帧", () => {
  const buffer = encodeLog(SAMPLE);
  const plain = decompressFrames(buffer).toString("utf8");
  assert.equal(plain, SAMPLE.join("\n") + "\n");
});

test("非 zstd 输入给出明确错误", () => {
  assert.throws(() => listFrames(Buffer.from("plain text")), /not a zstd stream/);
});
