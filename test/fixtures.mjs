/**
 * Synthetic format-v0 session logs used by the test-suite.
 * @module dsh-session-migration-repair/test/fixtures
 */

const TIME = 1789146000000;

/** A minimal v0 log carrying one of every defect this plugin repairs. */
export function defectiveLog() {
  const rows = [
    { type: "session", version: 0, id: "session-test-0001", createdAt: TIME - 1000, cwd: "/tmp/workspace", delegationDepth: 0, agentPreset: "standard" },
    { type: "permission/preset", seq: 0, time: TIME, data: { preset: "workspace-write" } },
    { type: "sandbox/mode", seq: 1, time: TIME, data: { mode: "workspace-write" } },
    { type: "approval/policy", seq: 2, time: TIME, data: { policy: "ask" } },
    { type: "turn/start", seq: 3, time: TIME, data: { turn: 1 } },
    { type: "step/start", seq: 4, time: TIME, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", seq: 5, time: TIME, data: { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "tool-call" } } },
    { type: "assistant/chunk", seq: 6, time: TIME, data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id: "call_stream_1", name: "todo_write", argumentsDelta: "" } } },
    // 缺陷 A：分片行 id/name 为空（旧版只在首行写 id）
    { type: "tool-call-chunks", seq0: 7, time0: TIME, data: { turn: 1, step: 1, index: 0, dt: [5], id: "", name: "", args: ["{\"todos\":", " []}"] } },
    // 缺陷 B：block-end 的 tool-call 块 id/name 为空
    { type: "assistant/chunk", seq: 10, time: TIME, data: { turn: 1, step: 1, chunk: { type: "block-end", index: 0, block: { type: "tool-call", id: "", name: "", arguments: "{\"todos\": []}" } } } },
    // 缺陷 C：消息里 tool-call 块 name 为空
    { type: "assistant/message", seq: 11, time: TIME, data: { turn: 1, step: 1, message: { id: "msg-1", role: "assistant", content: [{ type: "tool-call", id: "call_repair_1", name: "", arguments: "{\"todos\": []}" }], source: { kind: "assistant" } } } },
    // 缺陷 D：tool/call name 为空，且 arguments 与消息声明不一致
    { type: "tool/call", seq: 12, time: TIME, data: { turn: 1, step: 1, callId: "call_repair_1", name: "", arguments: "{\"todos\": [] }" } },
    { type: "tool/result", seq: 13, time: TIME, data: { turn: 1, step: 1, message: { id: "res-1", role: "user", content: [{ type: "tool-result", toolCallId: "call_repair_1", content: [{ type: "text", text: "已更新待办" }] }], source: { kind: "tool", callId: "call_repair_1" } } } },
    { type: "step/end", seq: 14, time: TIME, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 15, time: TIME, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/** A clean log (no defects) with multi-byte content, used for round-trip tests. */
export function cleanLog() {
  return defectiveLog();
}
