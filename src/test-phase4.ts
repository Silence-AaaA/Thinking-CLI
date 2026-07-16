/**
 * Phase 4 Context Engineering 测试
 *
 * 测试 Working Memory + History Compressor + Context Assembler
 */

import { WorkingMemory } from "./core/working-memory.js";
import { HistoryCompressor } from "./core/history-compressor.js";
import { ContextAssembler } from "./core/context-assembler.js";
import { StateMachine, ExecutionStatus } from "./core/state-machine.js";
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
console.log("\n🧪 Phase 4: Working Memory 测试\n");
// ============================================================

{
  const wm = new WorkingMemory();

  // 初始状态
  const s0 = wm.snapshot();
  assert(s0.currentGoal === "", "初始目标为空");
  assert(s0.findings.length === 0, "初始发现为空");

  // 设置目标
  wm.setGoal("read and analyze package.json");
  assert(wm.snapshot().currentGoal === "read and analyze package.json", "目标设置正确");

  // 添加发现
  wm.addFinding({ content: "package.json has 3 dependencies", source: "read_file", file: "package.json", importance: "high" });
  wm.addFinding({ content: "no TODO comments", source: "grep", importance: "low" });
  assert(wm.snapshot().findings.length === 2, "发现数: 2");

  // 活跃文件
  wm.addActiveFile("package.json");
  wm.addActiveFile("tsconfig.json");
  assert(wm.snapshot().activeFiles.length === 2, "活跃文件数: 2");

  // 错误记录
  wm.addError("read_file: ENOENT for /bad/path");
  assert(wm.snapshot().recentErrors.length === 1, "错误数: 1");

  // 决策记录
  wm.addDecision("Using grep before reading entire files");
  assert(wm.snapshot().decisions.length === 1, "决策数: 1");

  // 格式化输出
  const formatted = wm.formatForLLM();
  assert(formatted.includes("## Working Memory"), "格式化包含标题");
  assert(formatted.includes("read and analyze package.json"), "格式化包含目标");
  assert(formatted.includes("package.json"), "格式化包含活跃文件");
  assert(formatted.includes("[high]"), "格式化包含重要度标记");

  // 发现上限（15 条）
  for (let i = 0; i < 20; i++) {
    wm.addFinding({ content: `finding ${i}`, source: "test", importance: "low" });
  }
  assert(wm.snapshot().findings.length <= 15, `发现数不超过上限: ${wm.snapshot().findings.length}`);

  // 错误上限（5 条）
  for (let i = 0; i < 10; i++) {
    wm.addError(`error ${i}`);
  }
  assert(wm.snapshot().recentErrors.length === 5, `错误数不超过上限: ${wm.snapshot().recentErrors.length}`);

  // Token 估算
  const tokens = wm.estimateTokens();
  assert(tokens > 0, `Token 估算 > 0: ${tokens}`);

  // 重置
  wm.reset();
  const s1 = wm.snapshot();
  assert(s1.currentGoal === "", "重置后目标为空");
  assert(s1.findings.length === 0, "重置后发现为空");
  assert(s1.activeFiles.length === 0, "重置后文件为空");
}

// ============================================================
console.log("\n🧪 Phase 4: History Compressor 测试\n");
// ============================================================

{
  const hc = new HistoryCompressor({ recentRounds: 2, minRoundsToCompress: 3 });

  // 短对话不应压缩
  const shortMessages: Message[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "read package.json" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_file", arguments: { path: "package.json" } }] },
    { role: "tool", tool_call_id: "1", content: '{"name":"test"}' },
    { role: "assistant", content: "Here is the file content." },
  ];
  assert(hc.shouldCompress(shortMessages) === false, "短对话不压缩");

  // 构造长对话（8+ 轮）
  const longMessages: Message[] = [
    { role: "system", content: "You are helpful." },
  ];
  for (let i = 0; i < 10; i++) {
    longMessages.push({ role: "user", content: `task ${i}` });
    longMessages.push({ role: "assistant", content: "", tool_calls: [{ id: `${i}`, name: "read_file", arguments: { path: `file${i}.ts` } }] });
    longMessages.push({ role: "tool", tool_call_id: `${i}`, content: `content of file ${i}` });
    longMessages.push({ role: "assistant", content: `Result for task ${i}` });
  }

  assert(hc.shouldCompress(longMessages) === true, "长对话应该压缩");

  // 执行压缩
  const result = hc.compress(longMessages);
  assert(result.compressedCount > 0, `压缩了 ${result.compressedCount} 条消息`);
  assert(result.recentMessages.length < longMessages.length, "压缩后消息数减少");
  assert(result.summary.length > 0, "摘要不为空");
  assert(result.summary.includes("Conversation History Summary"), "摘要包含标题");
  assert(result.summary.includes("read_file"), "摘要包含工具调用记录");

  // system message 保留
  const hasSystem = result.recentMessages.some((m) => m.role === "system");
  assert(hasSystem === true, "压缩后保留 system message");

  // 最近轮次的内容保留
  const hasRecent = result.recentMessages.some((m) =>
    m.role === "assistant" && (m.content as string).includes("task 9")
  );
  assert(hasRecent === true, "最近轮次内容保留");
}

// ============================================================
console.log("\n🧪 Phase 4: Context Assembler 测试\n");
// ============================================================

{
  const ca = new ContextAssembler({
    recentRounds: 3,
    minRoundsToCompress: 5,
    injectWorkingMemory: true,
    injectStateSnapshot: true,
  });

  const wm = new WorkingMemory();
  wm.setGoal("test task");
  wm.addFinding({ content: "found something", source: "grep", importance: "high" });
  wm.addActiveFile("test.ts");

  const sm = new StateMachine();
  sm.setGoal("test task");
  sm.transition(ExecutionStatus.EXECUTING);
  sm.recordStep({ toolName: "read_file", arguments: { path: "test.ts" }, success: true, durationMs: 50 });

  // 短对话
  const shortMessages: Message[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "read test.ts" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_file", arguments: { path: "test.ts" } }] },
    { role: "tool", tool_call_id: "1", content: "const x = 1;" },
    { role: "assistant", content: "The file contains a constant." },
  ];

  const assembled = ca.assemble(shortMessages, wm, sm);
  assert(assembled.messages.length > shortMessages.length, "组装后消息数增加（注入了 memory + snapshot）");
  assert(assembled.stats.totalMessages > 0, `总消息数: ${assembled.stats.totalMessages}`);
  assert(assembled.stats.workingMemoryTokens > 0, "Working Memory token > 0");
  assert(assembled.stats.stateSnapshotTokens > 0, "State Snapshot token > 0");
  assert(assembled.stats.estimatedTotalTokens > 0, "总 token 估算 > 0");

  // 检查组装后的消息包含 Working Memory
  const hasWM = assembled.messages.some((m) =>
    m.role === "user" && m.content.includes("## Working Memory")
  );
  assert(hasWM === true, "组装后包含 Working Memory");

  // 检查组装后的消息包含 State Snapshot
  const hasSS = assembled.messages.some((m) =>
    m.role === "user" && m.content.includes("## Execution State")
  );
  assert(hasSS === true, "组装后包含 State Snapshot");

  // 空 Working Memory 不注入
  const emptyWM = new WorkingMemory();
  const assembledEmpty = ca.assemble(shortMessages, emptyWM, sm);
  const hasEmptyWM = assembledEmpty.messages.some((m) =>
    m.role === "user" && m.content.includes("## Working Memory")
  );
  assert(hasEmptyWM === false, "空 Working Memory 不注入");

  // 长对话触发压缩
  const longMessages: Message[] = [
    { role: "system", content: "You are a coding agent." },
  ];
  for (let i = 0; i < 10; i++) {
    longMessages.push({ role: "user", content: `task ${i}` });
    longMessages.push({ role: "assistant", content: "", tool_calls: [{ id: `${i}`, name: "read_file", arguments: { path: `file${i}.ts` } }] });
    longMessages.push({ role: "tool", tool_call_id: `${i}`, content: `content of file ${i}` });
    longMessages.push({ role: "assistant", content: `Result ${i}` });
  }

  const assembledLong = ca.assemble(longMessages, wm, sm);
  assert(assembledLong.stats.compressedMessages > 0, `长对话压缩了 ${assembledLong.stats.compressedMessages} 条消息`);
  assert(assembledLong.messages.length < longMessages.length + 4, "压缩后消息总数减少");
}

// ============================================================
// 汇总
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Phase 4 Context Engineering 测试结果: ${passed} 通过, ${failed} 失败`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("✅ Phase 4 Context Engineering 测试全部通过！\n");
  console.log("新增模块:");
  console.log("  - Working Memory: 当前任务关键信息管理");
  console.log("  - History Compressor: 早期对话规则压缩");
  console.log("  - Context Assembler: 上下文组装器（整合 memory + snapshot + history）");
  console.log("\n新增 REPL 命令:");
  console.log("  - wm: 查看 Working Memory 状态");
  console.log("  - ctx: 查看上下文组装统计");
}
