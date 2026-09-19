/**
 * Phase 6 测试 — Information Lifecycle（五层记忆架构）
 *
 * 测试范围：
 * - Layer 1: Instruction Layer（层级发现 + 合并）
 * - Layer 2: Knowledge Layer（flat uuid.json + reason）
 * - Layer 3: Agent Notebook（Runtime State）
 * - Layer 4: Retrieval Engine（模块化过滤管线）
 * - Layer 5: Prompt Builder（从 ContextAssembler 重构）
 * - Extraction Scheduler（双阈值触发）
 */

import { InstructionLayer } from "./memory/instruction-layer.js";
import { KnowledgeStore } from "./memory/knowledge-layer.js";
import { AgentNotebookManager } from "./memory/agent-notebook.js";
import { RetrievalEngine, MetadataFilter, ImportanceFilter, RelevanceRanker } from "./memory/retrieval-engine.js";
import { PromptBuilder } from "./memory/prompt-builder.js";
import { ExtractionScheduler } from "./memory/extraction-scheduler.js";
import { StateMachine, ExecutionStatus } from "./core/state-machine.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let passed = 0;
let failed = 0;

function assert(condition: boolean | undefined, message: string) {
  if (condition === true) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

function section(name: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"=".repeat(60)}`);
}

// ============================================================
// Layer 1: Instruction Layer
// ============================================================
section("Layer 1: Instruction Layer");

const instructionLayer = new InstructionLayer({
  fileName: "TEST_THINKING.md",
  dirName: ".test_thinking",
});

// 测试：发现 Managed 层
{
  const ctx = await instructionLayer.discover(process.cwd(), "You are a coding agent.");
  assert(ctx.merged.includes("You are a coding agent."), "Managed prompt is included in merged context");
  assert(ctx.sources.length >= 1, "At least one source discovered");
  assert(ctx.sources[0].type === "managed", "First source is managed type");
  assert(ctx.sources[0].priority === 1, "Managed source has lowest priority");
}

// 测试：优先级排序
{
  const ctx = await instructionLayer.discover(process.cwd(), "managed prompt");
  const priorities = ctx.sources.map(s => s.priority);
  const sorted = [...priorities].sort((a, b) => a - b);
  assert(JSON.stringify(priorities) === JSON.stringify(sorted), "Sources sorted by priority ascending");
}

// 测试：版本递增
{
  const ctx1 = await instructionLayer.discover(process.cwd(), "v1");
  const ctx2 = await instructionLayer.discover(process.cwd(), "v2");
  assert(ctx2.version > ctx1.version, "Version increments on each discover");
}

// 测试：缓存
{
  instructionLayer.clearCache();
  assert(instructionLayer.getCached() === null, "Cache cleared after clearCache()");
  await instructionLayer.discover(process.cwd(), "test");
  assert(instructionLayer.getCached() !== null, "Cache populated after discover()");
}

// ============================================================
// Layer 3: Agent Notebook
// ============================================================
section("Layer 3: Agent Notebook");

const notebook = new AgentNotebookManager();

// 测试：设置目标
{
  notebook.setGoal("Refactor auth module");
  const data = notebook.getData();
  assert(data.goal.primary === "Refactor auth module", "Goal set correctly");
  assert(data.goal.status === "active", "Goal status is active");
  assert(data.version > 0, "Version bumped after setGoal");
}

// 测试：子目标
{
  notebook.addSubGoal("Analyze current structure");
  notebook.addSubGoal("Implement JWT");
  assert(notebook.getData().goal.subGoals.length === 2, "Two sub-goals added");
}

// 测试：决策记录
{
  notebook.addDecision("Use JWT over sessions", "SPA frontend needs stateless auth", ["Session cookies"]);
  const data = notebook.getData();
  assert(data.decisions.length === 1, "One decision recorded");
  assert(data.decisions[0].reason.includes("SPA frontend"), "Decision has reason");
  assert(data.decisions[0].alternatives?.includes("Session cookies"), "Decision has alternatives");
}

// 测试：步骤生命周期
{
  notebook.beginStep(1, "Searching for auth files", "grep");
  assert(notebook.getData().currentStep !== null, "Current step set");
  assert(notebook.getData().currentStep?.toolName === "grep", "Current step has tool name");

  notebook.completeStep(1, "success", "Found 3 auth files");
  assert(notebook.getData().currentStep === null, "Current step cleared after completion");
  assert(notebook.getData().worklog.length === 1, "Worklog entry created");
  assert(notebook.getData().worklog[0].outcome === "success", "Worklog outcome is success");
}

// 测试：blocked 状态
{
  notebook.setBlocked("Cannot find auth entry point", "Try listing directory first");
  assert(notebook.getData().blocked !== null, "Blocked state set");
  assert(notebook.getData().blocked?.attempts === 1, "Blocked attempts is 1");
  assert(notebook.getData().goal.status === "blocked", "Goal status is blocked");

  // 再次 blocked → attempts 递增
  notebook.setBlocked("Still stuck");
  assert(notebook.getData().blocked?.attempts === 2, "Blocked attempts incremented");
}

// 测试：观察记录
{
  notebook.addObservation({
    stepId: 2,
    summary: "read_file auth.ts — 784 lines",
    success: true,
    severity: "low",
    keyFindings: ["3 export functions", "no tests"],
  });
  assert(notebook.getData().observations.length === 1, "Observation recorded");
}

// 测试：snapshot / restore
{
  const snap = notebook.snapshot();
  const notebook2 = new AgentNotebookManager();
  notebook2.loadSnapshot(snap);
  assert(notebook2.getData().goal.primary === "Refactor auth module", "Snapshot restored: goal matches");
  assert(notebook2.getData().decisions.length === 1, "Snapshot restored: decisions match");
}

// 测试：formatForLLM
{
  const text = notebook.formatForLLM();
  assert(text.includes("## Agent Runtime State"), "formatForLLM has header");
  assert(text.includes("Refactor auth module"), "formatForLLM includes goal");
  assert(text.includes("Blocked"), "formatForLLM includes blocked state");
  assert(text.includes("JWT"), "formatForLLM includes decisions");
}

// 测试：reset
{
  notebook.reset();
  assert(notebook.getData().goal.primary === "", "Reset clears goal");
  assert(notebook.getData().decisions.length === 0, "Reset clears decisions");
  assert(notebook.getData().version === 0, "Reset resets version");
}

// 测试：finishGoal
{
  notebook.setGoal("Build API");
  notebook.finishGoal("completed");
  assert(notebook.getData().goal.status === "completed", "Goal marked completed");
}

// ============================================================
// Layer 2: Knowledge Layer
// ============================================================
section("Layer 2: Knowledge Layer");

const testStorageRoot = path.join(os.tmpdir(), "thinking-test-knowledge-" + Date.now());
const store = new KnowledgeStore({ storageRoot: testStorageRoot, projectId: "test-project" });

// 测试：保存 + 加载
{
  const entry = {
    id: "test-entry-1",
    type: "architecture" as const,
    scope: "project" as const,
    content: "Planner outputs DAG",
    reason: "Enables parallel execution, reduces total latency",
    importance: 4,
    confidence: 0.9,
    source: { kind: "extraction" as const, sessionId: "test-session" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    tags: ["planner", "architecture"],
  };

  await store.save(entry);
  const loaded = await store.load("test-entry-1");
  assert(loaded !== null, "Entry loaded successfully");
  assert(loaded?.content === "Planner outputs DAG", "Content matches");
  assert(loaded?.reason === "Enables parallel execution, reduces total latency", "Reason field preserved");
  assert(loaded?.type === "architecture", "Type preserved");
  assert(loaded?.accessCount === 1, "Access count incremented on load");
}

// 测试：索引
{
  const index = store.getIndex();
  assert(index.entries.length >= 1, "Index has entries");
  assert(index.entries[0].id === "test-entry-1", "Index entry ID matches");
  assert(index.entries[0].type === "architecture", "Index entry type matches");
}

// 测试：批量保存 + 加载
{
  const entries = [
    {
      id: "test-entry-2",
      type: "convention" as const,
      scope: "project" as const,
      content: "Use camelCase for variables",
      reason: "Consistent with existing codebase style",
      importance: 3,
      confidence: 0.85,
      source: { kind: "user" as const },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
      tags: ["naming", "style"],
    },
    {
      id: "test-entry-3",
      type: "experience" as const,
      scope: "project" as const,
      content: "grep is faster than reading entire files",
      reason: "Observation from multiple failed attempts with large files",
      importance: 5,
      confidence: 0.95,
      source: { kind: "observation" as const, stepId: 42 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
      tags: ["performance", "tool-usage"],
    },
  ];

  await store.saveBatch(entries);
  const all = await store.loadBatch();
  assert(all.length === 3, `Loaded all 3 entries (got ${all.length})`);
}

// 测试：删除
{
  await store.delete("test-entry-2");
  const remaining = await store.loadBatch();
  assert(remaining.length === 2, `After delete, 2 entries remain (got ${remaining.length})`);
  const index = store.getIndex();
  assert(index.entries.length === 2, "Index updated after delete");
}

// 测试：extractFromDecision
{
  const extracted = store.extractFromDecision({
    decision: "Use TypeScript strict mode",
    reason: "Catch type errors at compile time",
    stepId: 5,
  });
  assert(extracted.type === "experience", "Extracted decision has type experience");
  assert(extracted.reason === "Catch type errors at compile time", "Extracted decision has reason");
  assert(extracted.tags.includes("decision"), "Extracted decision has tag 'decision'");
}

// 测试：extractFromObservation
{
  const extracted = store.extractFromObservation({
    summary: "Test suite passed",
    keyFindings: ["15 tests passed", "0 failed"],
    success: true,
    severity: "low",
    stepId: 3,
  });
  assert(extracted === null, "Low severity success observation returns null (not worth storing)");

  const extractedFail = store.extractFromObservation({
    summary: "Build failed",
    keyFindings: ["TypeScript error in auth.ts"],
    success: false,
    severity: "high",
    stepId: 7,
  });
  assert(extractedFail !== null, "Failed observation is extracted");
  assert(extractedFail?.type === "experience", "Failed observation has type experience");
  assert(extractedFail?.tags.includes("failure"), "Failed observation has 'failure' tag");
}

// 测试：count
{
  assert(store.count() === 2, `Count is 2 (got ${store.count()})`);
}

// 测试：GC
{
  // 手动创建一个过期 + 低重要度的条目
  const oldEntry = {
    id: "old-entry",
    type: "fact" as const,
    scope: "project" as const,
    content: "Old fact",
    reason: "No longer relevant",
    importance: 1,
    confidence: 0.5,
    source: { kind: "extraction" as const },
    createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 天前
    updatedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    accessCount: 0,
    lastAccessedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
    tags: ["stale"],
  };
  await store.save(oldEntry);
  assert(store.count() === 3, "Old entry added");

  const removed = await store.gc();
  assert(removed === 1, `GC removed 1 old entry (got ${removed})`);
  assert(store.count() === 2, "Count back to 2 after GC");
}

// 清理测试文件
try {
  fs.rmSync(testStorageRoot, { recursive: true, force: true });
} catch {}

// ============================================================
// Layer 4: Retrieval Engine
// ============================================================
section("Layer 4: Retrieval Engine");

// 重新创建 store 用于检索测试
const retrievalStore = new KnowledgeStore({ storageRoot: testStorageRoot, projectId: "retrieval-test" });

// 准备测试数据
const testEntries = [
  {
    id: "r-1",
    type: "architecture" as const,
    scope: "project" as const,
    content: "Agent uses ReAct loop",
    reason: "Standard pattern for tool-using agents",
    importance: 5,
    confidence: 0.95,
    source: { kind: "extraction" as const },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 10,
    lastAccessedAt: Date.now(),
    tags: ["architecture", "core"],
  },
  {
    id: "r-2",
    type: "convention" as const,
    scope: "project" as const,
    content: "Use 2-space indentation",
    reason: "Matches existing codebase",
    importance: 3,
    confidence: 0.8,
    source: { kind: "user" as const },
    createdAt: Date.now(),
    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 天前
    accessCount: 2,
    lastAccessedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    tags: ["style"],
  },
  {
    id: "r-3",
    type: "experience" as const,
    scope: "project" as const,
    content: "grep before reading files",
    reason: "Large files cause context overflow",
    importance: 4,
    confidence: 0.9,
    source: { kind: "observation" as const },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 5,
    lastAccessedAt: Date.now(),
    tags: ["performance", "tool-usage"],
  },
];

await retrievalStore.saveBatch(testEntries);

// 测试：基本检索
{
  const engine = new RetrievalEngine({
    filters: [new MetadataFilter(), new ImportanceFilter(2)],
    ranker: new RelevanceRanker(),
  });

  const result = await engine.retrieve({}, retrievalStore);
  assert(result.entries.length === 3, `All 3 entries retrieved (got ${result.entries.length})`);
  assert(result.scores.size === 3, "All entries have scores");
  assert(result.strategy.includes("metadata"), "Strategy includes metadata filter");
}

// 测试：按 type 过滤
{
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({ types: ["architecture"] }, retrievalStore);
  assert(result.entries.length === 1, `Filtered to 1 architecture entry (got ${result.entries.length})`);
  assert(result.entries[0].id === "r-1", "Correct entry returned");
}

// 测试：按 tags 过滤
{
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({ tags: ["performance"] }, retrievalStore);
  assert(result.entries.length === 1, `Filtered to 1 performance entry (got ${result.entries.length})`);
  assert(result.entries[0].id === "r-3", "Correct entry returned by tag");
}

// 测试：limit
{
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({ limit: 1 }, retrievalStore);
  assert(result.entries.length === 1, `Limited to 1 result (got ${result.entries.length})`);
}

// 测试：排序（高 importance + 高 accessCount 应该排在前面）
{
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({}, retrievalStore);
  assert(result.entries[0].id === "r-1", "Highest importance entry ranked first");
}

// 测试：formatForLLM
{
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({}, retrievalStore);
  const text = engine.formatForLLM(result);
  assert(text.includes("## Relevant Knowledge"), "formatForLLM has header");
  assert(text.includes("ReAct loop"), "formatForLLM includes entry content");
  assert(text.includes("Reason:"), "formatForLLM includes reason");
}

// 清理
try {
  fs.rmSync(testStorageRoot, { recursive: true, force: true });
} catch {}

// ============================================================
// Layer 5: Prompt Builder
// ============================================================
section("Layer 5: Prompt Builder");

const promptBuilder = new PromptBuilder({ agentType: "coding" });

// 测试：基本构建
{
  const instructionCtx = {
    merged: "You are a coding agent.",
    sources: [{ path: "<builtin>", type: "managed" as const, priority: 1, content: "You are a coding agent." }],
    version: 1,
  };

  const notebookData = new AgentNotebookManager();
  notebookData.setGoal("Build REST API");

  const sm = new StateMachine();
  sm.setGoal("Build REST API");

  const result = promptBuilder.build({
    instruction: instructionCtx,
    notebook: notebookData.snapshot(),
    knowledge: { entries: [], scores: new Map(), strategy: "none", totalCandidates: 0, filteredCount: 0 },
    state: sm,
    rawMessages: [
      { role: "system", content: "system" },
      { role: "user", content: "Build a REST API" },
      { role: "assistant", content: "I will build the API." },
    ],
  });

  assert(result.messages.length > 0, "Prompt builder produces messages");
  assert(result.report.agentType === "coding", "Report has correct agent type");
  assert(result.report.totalMessages > 0, "Report has total message count");
  assert(result.messages[0].role === "system", "First message is system");
  assert(
    (result.messages[0].content as string).includes("coding agent"),
    "System prompt includes managed instruction"
  );
  assert(
    (result.messages[0].content as string).includes("git_diff"),
    "System prompt includes coding addendum"
  );
}

// 测试：research 类型
{
  const researchBuilder = new PromptBuilder({ agentType: "research" });

  const result = researchBuilder.build({
    instruction: { merged: "You are a research agent.", sources: [], version: 1 },
    notebook: new AgentNotebookManager().snapshot(),
    knowledge: { entries: [], scores: new Map(), strategy: "none", totalCandidates: 0, filteredCount: 0 },
    state: new StateMachine(),
    rawMessages: [],
  });

  assert(
    (result.messages[0].content as string).includes("Cite sources"),
    "Research builder includes research addendum"
  );
}

// ============================================================
// Extraction Scheduler
// ============================================================
section("Extraction Scheduler");

// 测试：初始化阶段
{
  const scheduler = new ExtractionScheduler({
    initTokenThreshold: 10000,
    tokenThreshold: 5000,
    toolCallThreshold: 3,
  });

  assert(!scheduler.shouldExtract(5000, false), "Below init threshold: no extraction");
  assert(!scheduler.shouldExtract(9999, false), "Still below init threshold: no extraction");
  assert(!scheduler.shouldExtract(10000, false), "At init threshold: initializes but no extraction yet");
}

// 测试：双阈值触发
{
  const scheduler = new ExtractionScheduler({
    initTokenThreshold: 1000,
    tokenThreshold: 500,
    toolCallThreshold: 2,
  });

  // 初始化
  scheduler.shouldExtract(1000, false);

  // token 增长不够
  scheduler.recordToolCall();
  scheduler.recordToolCall();
  assert(!scheduler.shouldExtract(1200, true), "Token delta too small: no extraction");

  // token 够了，但 tool calls 不够
  assert(!scheduler.shouldExtract(1600, false), "Token delta met but no tool calls: no extraction");

  // token 够了 + 无 tool call 的自然暂停
  assert(scheduler.shouldExtract(2200, false), "Token delta met + no tool calls in last turn: extraction triggered");
}

// 测试：重置
{
  const scheduler = new ExtractionScheduler();
  scheduler.shouldExtract(10000, false);
  scheduler.reset();
  const json = scheduler.toJSON();
  assert(!json.initialized, "Reset clears initialized state");
}

// 测试：序列化 / 恢复
{
  const scheduler = new ExtractionScheduler({ initTokenThreshold: 1000 });
  scheduler.shouldExtract(1000, false);
  const json = scheduler.toJSON();

  const scheduler2 = new ExtractionScheduler();
  scheduler2.loadJSON(json);
  assert(scheduler2.toJSON().initialized === true, "Restored initialized state");
}

// ============================================================
// 集成测试：Notebook + StateMachine 联动
// ============================================================
section("Integration: Notebook + StateMachine");

{
  const nb = new AgentNotebookManager();
  const sm = new StateMachine();

  nb.setGoal("Deploy to production");
  sm.setGoal("Deploy to production");

  // 模拟执行
  sm.transition(ExecutionStatus.EXECUTING);
  nb.beginStep(1, "Run tests", "shell");
  nb.syncFromStateMachine(sm);
  assert(nb.getData().goal.status === "active", "Goal remains active during execution");

  // 模拟完成
  sm.transition(ExecutionStatus.COMPLETED);
  nb.completeStep(1, "success", "All tests passed");
  nb.finishGoal("completed");
  nb.syncFromStateMachine(sm);
  assert(nb.getData().goal.status === "completed", "Goal completed after state machine completion");
  assert(nb.getData().worklog.length === 1, "Worklog has one entry");
  assert(nb.getData().worklog[0].outcome === "success", "Worklog entry is success");

  // Notebook 格式化
  const text = nb.formatForLLM();
  assert(text.includes("✅"), "formatForLLM shows completed icon");
  assert(text.includes("All tests passed"), "formatForLLM includes worklog summary");
}

// ============================================================
// 集成测试：Knowledge + Retrieval
// ============================================================
section("Integration: Knowledge + Retrieval");

{
  const integrationRoot = path.join(os.tmpdir(), "thinking-integration-" + Date.now());
  const intStore = new KnowledgeStore({ storageRoot: integrationRoot, projectId: "int-test" });

  // 从 Notebook 决策中提取知识
  const decision = {
    decision: "Use vitest over jest",
    reason: "Faster, native ESM support, better TypeScript integration",
    stepId: 3,
  };
  const entry = intStore.extractFromDecision(decision, "session-1");
  await intStore.save(entry);

  // 从 Notebook 观察中提取知识
  const obs = {
    summary: "TypeScript compilation error in auth.ts:42",
    keyFindings: ["Type mismatch: string vs number"],
    success: false,
    severity: "high" as const,
    stepId: 5,
  };
  const obsEntry = intStore.extractFromObservation(obs, "session-1");
  if (obsEntry) await intStore.save(obsEntry);

  // 检索
  const engine = new RetrievalEngine();
  const result = await engine.retrieve({ types: ["experience"] }, intStore);
  assert(result.entries.length === 2, `Retrieved 2 experience entries (got ${result.entries.length})`);

  // 验证 reason 存在
  const hasReason = result.entries.every(e => e.reason.length > 0);
  assert(hasReason, "All retrieved entries have reason field");

  // 清理
  try { fs.rmSync(integrationRoot, { recursive: true, force: true }); } catch {}
}

// ============================================================
// 总结
// ============================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`  Phase 6 测试结果`);
console.log(`${"=".repeat(60)}`);
console.log(`  ✅ Passed: ${passed}`);
console.log(`  ❌ Failed: ${failed}`);
console.log(`  Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}


