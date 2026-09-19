/**
 * Phase 4.6 Context Engine Upgrade 测试
 *
 * 测试 Working Memory v2 + History Compressor + Context Assembler v3
 */

import { ContextAssembler } from "./core/context-assembler.js";
import { HistoryCompressor } from "./core/history-compressor.js";
import { ExecutionStatus, StateMachine } from "./core/state-machine.js";
import { WorkingMemory } from "./core/working-memory.js";
import type { Message } from "./llm/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// ============================================================
console.log("\n🧪 Phase 4.6: Working Memory v2 测试\n");
// ============================================================

{
  const wm = new WorkingMemory();

  const s0 = wm.snapshot();
  assert(s0.currentGoal === "", "初始目标为空");
  assert(s0.findings.length === 0, "初始发现为空");
  assert(s0.version === 0, "初始 version = 0");

  wm.setGoal("read and analyze package.json");
  assert(wm.snapshot().currentGoal === "read and analyze package.json", "目标设置正确");
  assert(wm.snapshot().version >= 1, "设置目标后 version 递增");

  wm.addFinding({
    content: "package.json has 3 dependencies",
    source: { kind: "tool", toolName: "read_file", toolCallId: "t1", stepId: 1, filePath: "package.json" },
    file: "package.json",
    importance: "high",
    confidence: 0.92,
    strength: 14,
  });
  wm.addFinding({
    content: "no TODO comments",
    source: { kind: "observation", toolName: "grep", stepId: 2 },
    importance: "low",
    confidence: 0.7,
    strength: 6,
  });
  assert(wm.snapshot().findings.length === 2, "发现数: 2");
  assert(wm.snapshot().findings[0].confidence > 0.9, "高重要度 finding 带较高置信度");

  wm.addActiveFile("package.json");
  wm.addActiveFile("tsconfig.json");
  assert(wm.snapshot().activeFiles.length === 2, "活跃文件数: 2");

  wm.addError("read_file: file_not_found (/bad/path)");
  assert(wm.snapshot().recentErrors.length === 1, "错误数: 1");

  wm.addDecision("Using grep before reading entire files");
  assert(wm.snapshot().decisions.length === 1, "决策数: 1");

  wm.setCurrentStep(3);
  wm.tickStep(3);
  const sAfterTick = wm.snapshot();
  assert(
    sAfterTick.findings.some((f) => f.strength < 14),
    "tick 后存在 strength 衰减",
  );

  wm.addFinding({
    content: "package.json version is 0.4.6",
    source: { kind: "tool", toolName: "read_file", toolCallId: "t4", stepId: 4, filePath: "package.json" },
    file: "package.json",
    importance: "medium",
    confidence: 0.82,
    strength: 10,
  });
  wm.reinforceByFile("package.json", 2);
  const pkgFindings = wm.snapshot().findings.filter((f) => f.file === "package.json");
  assert(pkgFindings.length >= 2, "同一文件可产生多条记忆");
  assert(
    pkgFindings.some((f) => f.strength >= 12),
    "reinforce 后相关记忆强度提升",
  );

  wm.demoteByFile("tsconfig.json", 2);
  const tsFindings = wm.snapshot().findings.filter((f) => f.file === "tsconfig.json");
  assert(tsFindings.length === 0 || tsFindings.every((f) => f.strength <= 10), "demote 后相关记忆强度下降或已淘汰");

  const formatted = wm.formatForLLM();
  assert(formatted.includes("## Working Memory"), "格式化包含标题");
  assert(formatted.includes("Version:"), "格式化包含版本");
  assert(formatted.includes("read and analyze package.json"), "格式化包含目标");
  assert(formatted.includes("package.json"), "格式化包含活跃文件");
  assert(formatted.includes("[high|"), "格式化包含结构化重要度/强度标记");

  for (let i = 0; i < 25; i++) {
    wm.addFinding({
      content: `finding ${i}`,
      source: { kind: "tool", toolName: "read_file", stepId: 10 + i },
      importance: "low",
      confidence: 0.5,
      strength: 5,
    });
  }
  assert(wm.snapshot().findings.length <= 20, `发现数不超过上限: ${wm.snapshot().findings.length}`);

  for (let i = 0; i < 10; i++) {
    wm.addError(`error ${i}`);
  }
  assert(wm.snapshot().recentErrors.length === 5, `错误数不超过上限: ${wm.snapshot().recentErrors.length}`);

  assert(wm.estimateTokens() > 0, "Token 估算 > 0");

  wm.reset();
  const s1 = wm.snapshot();
  assert(s1.currentGoal === "", "重置后目标为空");
  assert(s1.findings.length === 0, "重置后发现为空");
  assert(s1.activeFiles.length === 0, "重置后文件为空");
  assert(s1.version === 0, "重置后 version=0");
}

// ============================================================
console.log("\n🧪 Phase 4.6: History Compressor 测试\n");
// ============================================================

{
  const hc = new HistoryCompressor({ recentRounds: 2, minRoundsToCompress: 3 });

  const shortMessages: Message[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "read package.json" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", name: "read_file", arguments: { path: "package.json" } }],
    },
    { role: "tool", tool_call_id: "1", content: '{"name":"test"}' },
    { role: "assistant", content: "Here is the file content." },
  ];
  assert(hc.shouldCompress(shortMessages) === false, "短对话不压缩");

  const longMessages: Message[] = [{ role: "system", content: "You are helpful." }];
  for (let i = 0; i < 10; i++) {
    longMessages.push({ role: "user", content: `task ${i}` });
    longMessages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `${i}`, name: "read_file", arguments: { path: `file${i}.ts` } }],
    });
    longMessages.push({ role: "tool", tool_call_id: `${i}`, content: `content of file ${i}` });
    longMessages.push({ role: "assistant", content: `Result for task ${i}` });
  }

  assert(hc.shouldCompress(longMessages) === true, "长对话应该压缩");

  const result = hc.compress(longMessages);
  assert(result.compressedCount > 0, `压缩了 ${result.compressedCount} 条消息`);
  assert(result.recentMessages.length < longMessages.length, "压缩后消息数减少");
  assert(result.summary.length > 0, "摘要不为空");
  assert(result.summary.includes("Conversation History Summary"), "摘要包含标题");
  assert(result.summary.includes("read_file"), "摘要包含工具调用记录");
  assert(
    result.recentMessages.some((m) => m.role === "system"),
    "压缩后保留 system message",
  );
  assert(
    result.recentMessages.some((m) => m.role === "assistant" && (m.content as string).includes("task 9")),
    "最近轮次内容保留",
  );
}

// ============================================================
console.log("\n🧪 Phase 4.6: Context Assembler v3 测试\n");
// ============================================================

{
  const ca = new ContextAssembler({
    recentRounds: 3,
    minRoundsToCompress: 5,
    injectWorkingMemory: true,
    injectStateSnapshot: true,
    contextWindowTokens: 20000,
    reserveForResponse: 1000,
  });

  const wm = new WorkingMemory();
  wm.setGoal("test task");
  wm.addFinding({
    content: "found something",
    source: { kind: "observation", toolName: "grep", stepId: 2 },
    importance: "high",
    confidence: 0.9,
    strength: 14,
  });
  wm.addActiveFile("test.ts");

  const sm = new StateMachine();
  sm.setGoal("test task");
  sm.transition(ExecutionStatus.EXECUTING);
  sm.recordStep({ toolName: "read_file", arguments: { path: "test.ts" }, success: true, durationMs: 50 });

  const shortMessages: Message[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "read test.ts" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_file", arguments: { path: "test.ts" } }] },
    { role: "tool", tool_call_id: "1", content: "const x = 1;" },
    { role: "assistant", content: "The file contains a constant." },
  ];

  const assembled = ca.assemble(shortMessages, wm, sm, 3);
  const r = assembled.report;
  assert(assembled.messages.length > shortMessages.length, "组装后消息数增加（注入了 memory + snapshot）");
  assert(r.totalMessages > 0, `总消息数: ${r.totalMessages}`);
  assert(r.estimatedTotalTokens > 0, "总 token 估算 > 0");
  assert(r.contextVersion >= 1, "context version 已递增");
  assert(r.memoryVersion >= 1, "memory version recorded");
  assert(r.step === 3, "step recorded in report");
  assert(Array.isArray(r.changedBecause), "changedBecause exists");
  assert(typeof r.checkpointCreated === "boolean", "checkpointCreated exists");
  assert(r.injectedMemory === true, "注入了 Working Memory");
  assert(r.injectedState === true, "注入了 State Snapshot");
  assert(r.sections.length > 0, "report 包含 sections");
  assert(
    r.sections.some((s) => s.name === "working_memory"),
    "report 包含 working_memory section",
  );
  assert(
    r.sections.some((s) => s.name === "state_snapshot"),
    "report 包含 state_snapshot section",
  );
  assert(
    r.sections.some((s) => s.name === "history"),
    "report 包含 history section",
  );
  assert(
    assembled.messages.some((m) => m.role === "user" && m.content.includes("## Working Memory")),
    "组装后包含 Working Memory",
  );
  assert(
    assembled.messages.some((m) => m.role === "user" && m.content.includes("## Execution State")),
    "组装后包含 State Snapshot",
  );

  const emptyWM = new WorkingMemory();
  const assembledEmpty = ca.assemble(shortMessages, emptyWM, sm, 4);
  assert(
    assembledEmpty.messages.some((m) => m.role === "user" && m.content.includes("## Working Memory")) === false,
    "空 Working Memory 不注入",
  );
  assert(assembledEmpty.report.injectedMemory === false, "空 Working Memory 在 report 中记录未注入");

  const longMessages: Message[] = [{ role: "system", content: "You are a coding agent." }];
  for (let i = 0; i < 10; i++) {
    longMessages.push({ role: "user", content: `task ${i}` });
    longMessages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `${i}`, name: "read_file", arguments: { path: `file${i}.ts` } }],
    });
    longMessages.push({ role: "tool", tool_call_id: `${i}`, content: `content of file ${i}` });
    longMessages.push({ role: "assistant", content: `Result ${i}` });
  }

  const assembledLong = ca.assemble(longMessages, wm, sm, 5);
  assert(assembledLong.report.compressedMessages > 0, `长对话压缩了 ${assembledLong.report.compressedMessages} 条消息`);
  assert(assembledLong.report.estimatedTotalTokens > 0, "长对话组装 token > 0");
  assert(assembledLong.messages.length < longMessages.length + 4, "压缩后消息总数减少");
  assert(
    assembledLong.report.checkpointCreated === true || assembledLong.report.compressedMessages > 0,
    "长对话触发压缩或创建 checkpoint",
  );
  assert(Array.isArray(assembledLong.report.changedBecause), "长对话 report 包含 changedBecause");
}

// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Phase 4.6 Context Engine Upgrade 测试结果: ${passed} 通过, ${failed} 失败`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("✅ Phase 4.6 Context Engine Upgrade 测试全部通过！\n");
  console.log("升级模块:");
  console.log("  - Working Memory v2: source/confidence/strength/decay");
  console.log("  - Context Assembler v3: AssembleReport + contextVersion + checkpoint + changelog");
  console.log("\n新增 REPL 命令:");
  console.log("  - wm: 查看 Working Memory（带强度/来源/步骤）");
  console.log("  - ctx: 查看 Context Assembly Report（分段 token / 压缩 / 裁剪原因）");
  console.log("  - metrics: 查看最近一次 run metrics");
  console.log("  - ctxdiff: 查看最近两个 context version 的差异");
}
