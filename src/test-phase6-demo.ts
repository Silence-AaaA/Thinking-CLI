/**
 * Phase 6 Demo — 用真实场景验证五层架构是否生效
 *
 * 运行方式：npx tsx src/test-phase6-demo.ts
 *
 * 每一层都有明确的"成功标志"，你可以直接看到输出判断是否生效
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ExecutionStatus, StateMachine } from "./core/state-machine.js";
import { AgentNotebookManager } from "./memory/agent-notebook.js";
import { ExtractionScheduler } from "./memory/extraction-scheduler.js";
import { InstructionLayer } from "./memory/instruction-layer.js";
import { KnowledgeStore } from "./memory/knowledge-layer.js";
import { PromptBuilder } from "./memory/prompt-builder.js";
import { ImportanceFilter, MetadataFilter, RelevanceRanker, RetrievalEngine } from "./memory/retrieval-engine.js";

const SEP = "═".repeat(70);
const SUBSEP = "─".repeat(50);

// ============================================================
// Demo 1: Instruction Layer — 层级发现
//
// 【验证方法】
// 1. 在项目根目录创建 THINKING.md，写入自定义指令
// 2. 运行此脚本，观察 merged 输出是否包含你的指令
// 3. 观察优先级排序是否正确（managed < project）
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 1: Instruction Layer — 层级发现");
console.log(`${SEP}`);

// 先创建一个测试用的 THINKING.md
const testThinkingMd = `# Project Rules
- Always use TypeScript strict mode
- Prefer const over let
- Error messages must be in Chinese`;

const testDir = path.join(os.tmpdir(), "thinking-demo-" + Date.now());
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(path.join(testDir, "THINKING.md"), testThinkingMd, "utf-8");

const instructionLayer = new InstructionLayer({
  fileName: "THINKING.md",
  dirName: ".thinking",
});

const ctx = await instructionLayer.discover(testDir, "You are a helpful coding assistant.");

console.log("\n📋 发现的指令源（按优先级升序）：");
for (const source of ctx.sources) {
  console.log(`   [${source.type}] priority=${source.priority} → ${source.path}`);
}

console.log(`\n📄 合并后的指令上下文（前 300 字符）：`);
console.log(`   ${ctx.merged.slice(0, 300)}...`);

// 验证
const hasProjectRules = ctx.merged.includes("TypeScript strict mode");
const hasManagedPrompt = ctx.merged.includes("helpful coding assistant");
const projectAfterManaged = ctx.merged.indexOf("Project Rules") > ctx.merged.indexOf("helpful coding assistant");

console.log(`\n✅ 验证：`);
console.log(`   包含项目指令（TypeScript strict mode）: ${hasProjectRules ? "✅ YES" : "❌ NO"}`);
console.log(`   包含框架指令（helpful coding assistant）: ${hasManagedPrompt ? "✅ YES" : "❌ NO"}`);
console.log(`   项目指令在框架指令之后（优先级反转）: ${projectAfterManaged ? "✅ YES" : "❌ NO"}`);

// ============================================================
// Demo 2: Knowledge Layer — 持久化 + reason
//
// 【验证方法】
// 1. 观察 uuid.json 文件是否在磁盘上创建
// 2. 观察每条知识是否带 reason 字段
// 3. 观察 index.json 是否自动生成
// 4. 打开磁盘上的 json 文件，检查内容
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 2: Knowledge Layer — 持久化 + reason");
console.log(`${SEP}`);

const knowledgeDir = path.join(testDir, "knowledge");
const store = new KnowledgeStore({ storageRoot: testDir, projectId: "demo-project" });

// 模拟：Agent 在执行过程中学到了一些知识
const knowledge = [
  {
    type: "architecture" as const,
    content: "项目使用 ReAct 循环模式",
    reason: "观察 agent.ts 发现 while(true) 循环 + tool_calls 模式",
    importance: 5,
    tags: ["architecture", "core"],
  },
  {
    type: "convention" as const,
    content: "所有工具函数返回 ToolResult 类型",
    reason: "tool-tools.ts 中统一接口定义，便于 Observation Layer 提取",
    importance: 4,
    tags: ["convention", "tools"],
  },
  {
    type: "experience" as const,
    content: "grep 比 read_file 更高效",
    reason: "多次尝试读取大文件导致 context overflow，改用 grep 后解决",
    importance: 3,
    tags: ["performance", "lesson"],
  },
];

console.log("\n💾 保存知识条目：");
const savedIds: string[] = [];
for (const k of knowledge) {
  const entry = {
    id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    scope: "project" as const,
    source: { kind: "extraction" as const, sessionId: "demo-session" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    confidence: 0.85,
    ...k,
  };
  await store.save(entry);
  savedIds.push(entry.id);
  console.log(`   [${entry.type}] ${entry.content}`);
  console.log(`          reason: ${entry.reason}`);
}

// 验证磁盘文件
console.log(`\n📁 磁盘上的文件：`);
const knowledgePath = path.join(testDir, "projects", "demo-project", "knowledge");
if (fs.existsSync(knowledgePath)) {
  const files = fs.readdirSync(knowledgePath);
  for (const f of files) {
    const stat = fs.statSync(path.join(knowledgePath, f));
    console.log(`   ${f} (${stat.size} bytes)`);
  }
}

// 验证 index.json
const indexPath = path.join(testDir, "projects", "demo-project", "index.json");
if (fs.existsSync(indexPath)) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  console.log(`\n📑 index.json 内容：`);
  console.log(`   条目数: ${index.entries.length}`);
  for (const e of index.entries) {
    console.log(`   - [${e.type}] importance=${e.importance} tags=[${e.tags.join(", ")}]`);
  }
}

// 验证单条知识的 reason
const loaded = await store.load(savedIds[0]);
console.log(`\n✅ 验证：`);
console.log(`   磁盘文件存在: ${fs.existsSync(knowledgePath) ? "✅ YES" : "❌ NO"}`);
console.log(`   index.json 存在: ${fs.existsSync(indexPath) ? "✅ YES" : "❌ NO"}`);
console.log(`   reason 字段保留: ${loaded?.reason ? "✅ YES" : "❌ NO"}`);
console.log(`   reason 内容: "${loaded?.reason}"`);

// ============================================================
// Demo 3: Agent Notebook — Runtime State
//
// 【验证方法】
// 1. 观察每步操作后 Notebook 的状态变化
// 2. 观察 formatForLLM 输出是否是结构化状态（不是自然语言摘要）
// 3. 观察 snapshot 能否被另一个 Notebook 实例恢复
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 3: Agent Notebook — Runtime State");
console.log(`${SEP}`);

const notebook = new AgentNotebookManager();

// 模拟一个完整的任务执行流程
console.log("\n🎬 模拟任务执行流程：\n");

// Step 1: 设置目标
notebook.setGoal("实现用户认证模块");
console.log("   ① setGoal('实现用户认证模块')");
console.log(`      → goal.status = ${notebook.getData().goal.status}`);

// Step 2: 规划
notebook.updatePlan({
  id: "plan-1",
  goal: "实现用户认证模块",
  steps: [
    { id: 1, description: "分析现有代码结构", dependencies: [], status: "pending", retryCount: 0 },
    { id: 2, description: "设计 JWT 方案", dependencies: [1], status: "pending", retryCount: 0 },
    { id: 3, description: "实现认证中间件", dependencies: [2], status: "pending", retryCount: 0 },
    { id: 4, description: "编写测试", dependencies: [3], status: "pending", retryCount: 0 },
  ],
  createdAt: Date.now(),
});
console.log("   ② updatePlan: 4 steps");

// Step 3: 执行第一步
notebook.beginStep(1, "读取项目目录结构", "list_dir");
console.log("   ③ beginStep(1, '读取项目目录结构', 'list_dir')");
console.log(`      → currentStep = ${notebook.getData().currentStep?.action}`);

// Step 3b: 完成第一步
notebook.addObservation({
  stepId: 1,
  summary: "发现 src/auth/ 目录不存在",
  success: true,
  severity: "medium",
  keyFindings: ["需要新建 auth 模块", "现有 session 管理在 middleware.ts"],
});
notebook.completeStep(1, "success", "发现需要新建 auth 模块");
console.log("   ④ completeStep(1, 'success', '发现需要新建 auth 模块')");

// Step 4: 记录决策
notebook.addDecision("使用 JWT 而非 session cookies", "前端是 SPA，无状态认证更合适；JWT 可以跨服务共享", [
  "Session Cookies",
  "OAuth2",
]);
console.log("   ⑤ addDecision('使用 JWT', '前端是 SPA...')");

// Step 5: 执行第二步
notebook.beginStep(2, "设计 JWT 认证方案");
console.log("   ⑥ beginStep(2, '设计 JWT 认证方案')");

// Step 6: 遇到阻塞
notebook.setBlocked("找不到密钥管理方案", "考虑使用环境变量或 Vault");
console.log("   ⑦ setBlocked('找不到密钥管理方案')");

// Step 7: 解除阻塞，继续
notebook.beginStep(2, "设计 JWT 认证方案（已解决密钥问题）");
notebook.addDecision("使用环境变量管理 JWT 密钥", "项目规模小，Vault 过度设计；环境变量 + .env 文件足够", [
  "HashiCorp Vault",
  "AWS Secrets Manager",
]);
notebook.completeStep(2, "success", "JWT 方案设计完成");
console.log("   ⑧ 解除阻塞，完成 step 2");

// 输出 Notebook 状态
console.log(`\n${SUBSEP}`);
console.log("📖 Notebook formatForLLM() 输出：\n");
console.log(notebook.formatForLLM());

// 验证 snapshot 共享
const snap = notebook.snapshot();
const notebook2 = new AgentNotebookManager();
notebook2.loadSnapshot(snap);

console.log(`\n${SUBSEP}`);
console.log("✅ 验证：");
console.log(`   Notebook 版本: ${notebook.getData().version}`);
console.log(`   决策数量: ${notebook.getData().decisions.length}`);
console.log(`   观察数量: ${notebook.getData().observations.length}`);
console.log(`   工作日志: ${notebook.getData().worklog.length} 条`);
console.log(
  `   Snapshot 共享后目标一致: ${notebook2.getData().goal.primary === "实现用户认证模块" ? "✅ YES" : "❌ NO"}`,
);
console.log(`   Snapshot 共享后决策一致: ${notebook2.getData().decisions.length === 2 ? "✅ YES" : "❌ NO"}`);

// ============================================================
// Demo 4: Retrieval Engine — 模块化检索
//
// 【验证方法】
// 1. 观察不同 query 返回不同结果
// 2. 观察排序是否按 importance + confidence + recency
// 3. 观察 formatForLLM 是否包含 reason
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 4: Retrieval Engine — 模块化检索");
console.log(`${SEP}`);

const engine = new RetrievalEngine();

// Query 1: 查找所有架构知识
console.log("\n🔍 Query 1: 查找架构知识 (types=['architecture'])");
const r1 = await engine.retrieve({ types: ["architecture"] }, store);
for (const e of r1.entries) {
  const score = r1.scores.get(e.id) ?? 0;
  console.log(`   [${e.type}] ${e.content} (score=${score.toFixed(3)})`);
  console.log(`          reason: ${e.reason}`);
}

// Query 2: 查找性能相关的经验
console.log("\n🔍 Query 2: 查找性能经验 (tags=['performance'])");
const r2 = await engine.retrieve({ tags: ["performance"] }, store);
for (const e of r2.entries) {
  console.log(`   [${e.type}] ${e.content}`);
  console.log(`          reason: ${e.reason}`);
}

// Query 3: 全部检索，观察排序
console.log("\n🔍 Query 3: 全部检索，观察排序（应按 importance 降序）");
const r3 = await engine.retrieve({}, store);
for (const e of r3.entries) {
  const score = r3.scores.get(e.id) ?? 0;
  console.log(`   importance=${e.importance} score=${score.toFixed(3)} → ${e.content}`);
}

// 验证 formatForLLM
console.log(`\n📄 formatForLLM 输出：\n`);
console.log(engine.formatForLLM(r3));

console.log(`\n✅ 验证：`);
console.log(`   按 type 过滤生效: ${r1.entries.length === 1 ? "✅ YES" : "❌ NO"} (期望 1 条架构知识)`);
console.log(`   按 tags 过滤生效: ${r2.entries.length === 1 ? "✅ YES" : "❌ NO"} (期望 1 条性能经验)`);
console.log(`   排序正确（importance 5 在前）: ${r3.entries[0]?.importance === 5 ? "✅ YES" : "❌ NO"}`);
console.log(`   formatForLLM 包含 reason: ${engine.formatForLLM(r3).includes("Reason:") ? "✅ YES" : "❌ NO"}`);

// ============================================================
// Demo 5: Prompt Builder — 最终组装
//
// 【验证方法】
// 1. 观察 system prompt 是否包含 Instruction Layer 的内容
// 2. 观察 Notebook 状态是否注入
// 3. 观察 Knowledge 是否注入
// 4. 对比 coding vs research 的 system prompt 差异
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 5: Prompt Builder — 最终组装");
console.log(`${SEP}`);

const sm = new StateMachine();
sm.setGoal("实现用户认证模块");
sm.transition(ExecutionStatus.EXECUTING);

const codingBuilder = new PromptBuilder({ agentType: "coding" });
const researchBuilder = new PromptBuilder({ agentType: "research" });

const components = {
  instruction: ctx,
  notebook: notebook.snapshot(),
  knowledge: r3,
  state: sm,
  rawMessages: [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "帮我实现用户认证模块" },
  ],
};

const codingResult = codingBuilder.build(components);
const researchResult = researchBuilder.build(components);

console.log("\n📦 Coding Agent 的 system prompt（前 500 字符）：");
console.log(`   ${codingResult.messages[0].content.slice(0, 500)}...`);

console.log("\n📦 Research Agent 的 system prompt（前 500 字符）：");
console.log(`   ${researchResult.messages[0].content.slice(0, 500)}...`);

// 验证差异
const codingHasGitDiff = codingResult.messages[0].content.includes("git_diff");
const researchHasCite = researchResult.messages[0].content.includes("Cite sources");

console.log(`\n✅ 验证：`);
console.log(`   Coding prompt 包含 git_diff 指令: ${codingHasGitDiff ? "✅ YES" : "❌ NO"}`);
console.log(`   Research prompt 包含 Cite sources: ${researchHasCite ? "✅ YES" : "❌ NO"}`);
console.log(
  `   Notebook 注入: ${(codingResult.report.sections.find((s) => s.name === "notebook")?.messageCount ?? 0) > 0 ? "✅ YES" : "❌ NO"}`,
);
console.log(`   Knowledge 注入: ${codingResult.report.retrievalCount > 0 ? "✅ YES" : "❌ NO"}`);
console.log(`   总消息数: ${codingResult.report.totalMessages}`);
console.log(`   估算 token: ${codingResult.report.estimatedTotalTokens}`);

// ============================================================
// Demo 6: Extraction Scheduler — 双阈值触发
//
// 【验证方法】
// 观察触发时机是否正确：
// - token 不够 → 不触发
// - token 够了但 tool calls 不够 → 不触发
// - 两者都够 → 触发
// ============================================================
console.log(`\n${SEP}`);
console.log("  Demo 6: Extraction Scheduler — 双阈值触发");
console.log(`${SEP}`);

const scheduler = new ExtractionScheduler({
  initTokenThreshold: 5000,
  tokenThreshold: 2000,
  toolCallThreshold: 3,
});

const scenarios = [
  { tokens: 3000, toolCalls: false, expect: false, desc: "token 不够 (3000 < 5000 init)" },
  { tokens: 6000, toolCalls: false, expect: false, desc: "初始化完成 (6000 >= 5000 init)" },
  { tokens: 7000, toolCalls: true, expect: false, desc: "token 增长不够 (1000 < 2000)" },
  { tokens: 7500, toolCalls: true, expect: false, desc: "token 增长不够 (500 < 2000), +1 tool call" },
  { tokens: 8000, toolCalls: true, expect: false, desc: "token 增长不够 (0 < 2000), +1 tool call" },
  { tokens: 9500, toolCalls: false, expect: false, desc: "token 够了 (1500 < 2000), 但自然暂停" },
  { tokens: 12000, toolCalls: false, expect: true, desc: "token 够了 (2500 >= 2000) + 自然暂停 → 触发!" },
];

console.log("\n⏱️ 触发场景模拟：\n");
for (const s of scenarios) {
  if (s.toolCalls) scheduler.recordToolCall();
  const result = scheduler.shouldExtract(s.tokens, s.toolCalls);
  const icon = result === s.expect ? "✅" : "❌";
  console.log(`   ${icon} ${s.desc} → ${result ? "TRIGGERED" : "skip"}`);
}

// ============================================================
// 清理
// ============================================================
try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}

console.log(`\n${SEP}`);
console.log("  Demo 完成！所有验证点已输出。");
console.log(`${SEP}`);
