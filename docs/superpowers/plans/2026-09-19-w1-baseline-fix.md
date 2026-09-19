# W1 基线修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 1 周内把「一眼就能看出有问题」的基线修干净:统一测试入口、引入 Biome 质量门、清理 23 处死代码、接通任务路由、打磨 CLI/UX,为 W2 真实任务验证提供干净起点。

**Architecture:** 不新增子系统、不改对外行为;全部是工程硬化——补齐被测遗漏的测试脚本链、Biome 质量门、TS 类型收紧、把已存在但未接线的 TaskRouter 接成 `Agent.runAuto()`、CLI 错误引导与退出码。唯一质量门是 `npm run check`。

**Tech Stack:** TypeScript(ESM / NodeNext)、Commander、vitest、Biome、tsx。LLM 适配层(openai-adapter)在本计划内不做改动。

**范围:** 只覆盖设计文档 §3.2(S1 基线修复)。W2-W4 在各里程碑开始时独立出计划。设计文档: `docs/superpowers/specs/2026-09-19-thinking-agent-production-polish-design.md`

---

## 前置要求

- 工作目录:`D:\agentCode\Thinking`;shell:PowerShell
- 涉及网络的步骤(`npm i`)需要用户批准
- 每 Task 结束提交一次 git;提交前 `git status --short` 确认只包含本任务文件

---

## Task 0: 提交现状基线(Git housekeeping)

**Files:**
- Commit: 全部未提交内容(`src/memory/`、`src/test-phase6-demo.ts`、`src/test-phase6.ts`、`src/capabilities.ts`、`src/config.ts`、`src/memory/`、`docs/phase6-report.md`、`docs/decisions/ADR-022-information-lifecycle.md`、`.thinking.json`、`THINKING.md` 以及已修改文件)

- [ ] **Step 1: 确认现状**

Run: `git status --short`
Expected: 至少出现 `?? src/memory/` 与 `?? docs/phase6-report.md`。

- [ ] **Step 2: 确认 .env 被忽略**

Run: `git check-ignore .env`
Expected: 输出 `.env`;若无输出,先把 `.env` 追加进 `.gitignore` 再继续。

- [ ] **Step 3: 提交基线**

```bash
git add -A
git commit -m "chore: snapshot pre-polish baseline (phases 1-6 as-is)"
```
Expected: 提交成功;`git log --oneline -1` 显示该 commit。

- [ ] **Step 4: 验证工作区干净**

Run: `git status --short`
Expected: 无输出。

---

## Task 1: 统一测试入口

**Files:**
- Modify: `package.json`(scripts)

- [ ] **Step 1: 确认被遗漏的 3 个测试脚本当前可过**

Run:
```powershell
npx tsx src/test-phase5.ts; npx tsx src/test-task-router.ts; npx tsx src/test-bypass.ts
```
Expected: 三者均以「✅ All ... tests passed」/「7 通过, 0 失败」结尾(2026-09-19 实测均为通过)。若任一失败,先定位修复再继续。

- [ ] **Step 2: 修改 package.json scripts**

将:
```json
"test:all": "tsx src/test.ts && tsx src/test-observation.ts && tsx src/test-phase3.ts && tsx src/test-phase3-exec.ts && tsx src/test-phase4.ts && tsx src/test-phase6.ts"
```
改为:
```json
"test:all": "tsx src/test.ts && tsx src/test-observation.ts && tsx src/test-phase3.ts && tsx src/test-phase3-exec.ts && tsx src/test-phase4.ts && tsx src/test-phase5.ts && tsx src/test-task-router.ts && tsx src/test-bypass.ts && tsx src/test-phase6.ts",
"test:unit": "vitest run",
"test": "npm run test:all && npm run test:unit",
"coverage": "vitest run --coverage"
```

- [ ] **Step 3: 安装覆盖率依赖**

Run: `npm i -D @vitest/coverage-v8`
Expected: 安装成功(需网络批准)。

- [ ] **Step 4: 验证 `npm test` 全绿**

Run: `npm test`
Expected: 全部脚本 PASS(含新增 phase5 / task-router / bypass)+ vitest working-memory 套件通过。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json
git commit -m "test: unify test entry, add missing phase5/router/bypass, add vitest unit and coverage"
```

---

## Task 2: 引入 Biome 质量门

**Files:**
- Create: `biome.json`
- Modify: `package.json`(scripts)

- [ ] **Step 1: 安装 Biome**

Run: `npm i -D biome`
Expected: 安装成功(需网络批准)。

- [ ] **Step 2: 创建 `biome.json`**

写入(注意:无 `$schema` 字段,避免版本绑定):
```json
{
  "files": { "includes": ["src/**/*.ts"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
```

- [ ] **Step 3: 添加 npm scripts**

`package.json` scripts 中加入:
```json
"lint": "biome check src",
"format": "biome format --write src",
"check": "tsc --noEmit && npm run lint && npm test"
```

- [ ] **Step 4: 自动修复 + 查看剩余问题**

Run:
```powershell
npx biome check src --write
npx biome check src
```
Expected: 第一次自动修复格式与可自动修复项;第二次剩余的输出若只有 `noUnusedVariables` / `noUnusedImports` 等「未使用」类诊断,记录即可(归 Task 3,biome 的 warn/info 级诊断不会让命令失败);若出现 correctness 级错误,按提示逐个修复,保持行为不变。

- [ ] **Step 5: 编译与测试仍绿**

Run: `npx tsc --noEmit`
Expected: 无错误。
Run: `npm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add biome.json package.json package-lock.json
git commit -m "style: add biome lint/format and npm quality scripts"
```
(若 Step 4 的 --write 已改动 src,则 `git add biome.json package.json package-lock.json src`)

---

## Task 3: 死代码与类型清理(23 处)

**Files:**
- Modify: `src/core/agent.ts`、`src/core/error-taxonomy.ts`、`src/core/observation.ts`、`src/core/reflection.ts`、`src/core/risk-assessor.ts`、`src/core/step-executor.ts`、`src/memory/agent-notebook.ts`、`src/memory/extraction-scheduler.ts`、`src/memory/prompt-builder.ts`、`src/memory/retrieval-engine.ts`、`src/tools/git-tools.ts`、`src/core/__tests__/working-memory.test.ts`
- Verify: 最终 `npx tsc --noUnusedLocals --noUnusedParameters --noEmit` 零错误

### 3.1 `src/core/agent.ts`
- [ ] **Step 1: 移除未用导入**

第 25 行 `import { TaskPlanner, type TaskPlan } from "./task-planner.js";` → `import { TaskPlanner } from "./task-planner.js";`
(`TaskRouter` 导入与 `taskRouter` 字段保留——Task 4 会真正使用。)

- [ ] **Step 2: 收紧 `knowledgeResult` 类型(第 167 行)**

将:
```ts
private knowledgeResult: { entries: any[]; scores: Map<string, number>; strategy: string; totalCandidates: number; filteredCount: number } = { entries: [], scores: new Map(), strategy: "none", totalCandidates: 0, filteredCount: 0 };
```
改为:
```ts
private knowledgeResult: RetrievalResult = { entries: [], scores: new Map<string, number>(), strategy: "none", totalCandidates: 0, filteredCount: 0 };
```
并在导入区加入:
```ts
import type { RetrievalResult } from "../memory/retrieval-engine.js";
```
(`RetrievalResult` 见 `src/memory/retrieval-engine.ts:52`,字段与初始值完全对应;scores 显式写成 `Map<string, number>()` 以满足接口。)

- [ ] **Step 3: `extractKnowledge` 参数类型化(第 696 行)**

`private async extractKnowledge(obs: any): Promise<void> {` → `private async extractKnowledge(obs: Observation): Promise<void> {`
若文件未导入 `Observation`,加入 `import type { Observation } from "./observation.js";`(调用点第 388 行 `observe()` 返回类型正是 `Observation`,传参无需改动)。

- [ ] **Step 4: 删除未使用的 `hashPath` 方法(第 216-220 行)**

删除:
```ts
/** 生成项目路径的稳定 hash（用于知识存储隔离） */
private hashPath(p: string): string {
  // using imported createHash
  return nodeCreateHash("sha256").update(p).digest("hex").slice(0, 12);
}
```
`nodeCreateHash` 导入保留(第 199 行仍在用)。

- [ ] **Step 5: 编译**

Run: `npx tsc --noEmit`
Expected: 无错误。

### 3.2 `src/core/error-taxonomy.ts`
- [ ] **Step 1: 删除未用 logger**

删第 94 行 `private logger = getLogger();` 与第 27 行 `import { getLogger } from "../utils/logger.js";`(全文无其他使用点)。
Run: `npx tsc --noEmit` → 无错误。

### 3.3 `src/core/observation.ts`
- [ ] **Step 1: `suggestRecovery` 去掉未用参数**

第 504 行 `function suggestRecovery(toolName: string, error: string): string {` → `function suggestRecovery(error: string): string {`
第 105 行 `suggestedAction: suggestRecovery(toolCall.name, errorText),` → `suggestedAction: suggestRecovery(errorText),`

- [ ] **Step 2: `suggestShellRecovery` 去掉未用参数**

第 515 行 `function suggestShellRecovery(command: string, exitCode: number | undefined, stderr: string): string {` → `function suggestShellRecovery(exitCode: number | undefined, stderr: string): string {`
第 328 行 `suggestedAction: suggestShellRecovery(command, exitCode, stderr),` → `suggestedAction: suggestShellRecovery(exitCode, stderr),`

- [ ] **Step 3: 编译**

Run: `npx tsc --noEmit` → 无错误。

### 3.4 `src/core/reflection.ts`
- [ ] **Step 1: 删除未用 logger**

删第 91 行 `private logger = getLogger();` 与第 28 行 `import { getLogger } from "../utils/logger.js";`。

- [ ] **Step 2: `check` 的未用参数下划线化(第 119 行)**

`check(snapshot: StateSnapshot, lastError?: { type: ErrorType; recovery: RecoveryAction }): ReflectionResult {` → `check(snapshot: StateSnapshot, _lastError?: { type: ErrorType; recovery: RecoveryAction }): ReflectionResult {`
(下划线前缀是 TS 对未用参数的豁免写法,调用点不变。)

- [ ] **Step 3: 编译**

Run: `npx tsc --noEmit` → 无错误。

### 3.5 `src/core/risk-assessor.ts`
- [ ] **Step 1: 删除未用 logger**

删第 36 行 `private logger = getLogger();` 与第 12 行 `import { getLogger } from "../utils/logger.js";`。

- [ ] **Step 2: 删除未使用变量 `lower`(第 173 行)**

删除 `const lower = command.toLowerCase();`(第 187-215 行所有正则带 `/i` 且直接作用于 `command`)。

- [ ] **Step 3: 编译**

Run: `npx tsc --noEmit` → 无错误。

### 3.6 `src/core/step-executor.ts`
- [ ] **Step 1: `executeWithReset` 去掉未用参数 `memory`(第 72-76 行)**

将:
```ts
async executeWithReset(
  plan: TaskPlan,
  agent: Agent,
  memory: WorkingMemory
): Promise<PlanExecutionResult> {
```
改为:
```ts
async executeWithReset(plan: TaskPlan, agent: Agent): Promise<PlanExecutionResult> {
```

- [ ] **Step 2: 更新 `src/core/agent.ts` 两处调用点**

第 636 行 `await this.stepExecutor.executeWithReset(plan, this, this.workingMemory);` → `await this.stepExecutor.executeWithReset(plan, this);`
第 652 行:同样替换。

- [ ] **Step 3: 清理可能变为未使用的导入**

Run: `rg -n "WorkingMemory" src/core/step-executor.ts`
若除 import 行外无其他使用,删除 `import { WorkingMemory } ...` 那一行(以实际导入写法为准)。

- [ ] **Step 4: 编译**

Run: `npx tsc --noEmit` → 无错误。

### 3.7 `src/memory/agent-notebook.ts`
- [ ] **Step 1: 精简未用类型导入(第 21-22 行)**

将:
```ts
import type { Observation, ObservationSeverity, ObservationStatus } from "../core/observation.js";
import type { StateMachine, StateSnapshot } from "../core/state-machine.js";
```
改为:
```ts
import type { ObservationSeverity } from "../core/observation.js";
import type { StateMachine } from "../core/state-machine.js";
```
(ObservationSeverity 与 StateMachine 仍被使用;Observation、ObservationStatus、StateSnapshot 未使用。)

### 3.8 `src/memory/extraction-scheduler.ts`
- [ ] **Step 1: 未用参数下划线化(第 101 行)**

`recordTokenCount(count: number): void {` → `recordTokenCount(_count: number): void {`
(方法体设计上为空,注释「只用于外部跟踪」;保留 API。)

### 3.9 `src/memory/prompt-builder.ts`
- [ ] **Step 1: 删除未用 logger**

删第 132 行 `private logger = getLogger();` 与第 33 行 `import { getLogger } from "../utils/logger.js";`。

### 3.10 `src/memory/retrieval-engine.ts`
- [ ] **Step 1: 移除未用导入(第 17-23 行)**

将:
```ts
import type {
  KnowledgeEntry,
  KnowledgeType,
  KnowledgeScope,
  KnowledgeStore,
  IndexEntry,
} from "./knowledge-layer.js";
```
改为:
```ts
import type { KnowledgeEntry, KnowledgeType, KnowledgeScope, KnowledgeStore } from "./knowledge-layer.js";
```

### 3.11 `src/tools/git-tools.ts`
- [ ] **Step 1: 未用参数下划线化(第 38 行)**

`execute: async (params): Promise<ToolResult> => {` → `execute: async (_params): Promise<ToolResult> => {`

### 3.12 `src/core/__tests__/working-memory.test.ts`
- [ ] **Step 1: 精简未用导入(第 14 行)**

`import type { MemorySource, Finding, WorkingMemorySnapshot } from "../working-memory.js";` → `import type { MemorySource } from "../working-memory.js";`

- [ ] **Step 2: 删除未用变量 `f1`(第 124 行)**

`const f1 = wm.addFinding(makeInput({ tags: ["key-a"], strength: 5 }));` → `wm.addFinding(makeInput({ tags: ["key-a"], strength: 5 }));`

- [ ] **Step 3: 删除未用变量 `f`(第 148 行)**

`const f = wm.addFinding(makeInput({ strength: 10 }));` → `wm.addFinding(makeInput({ strength: 10 }));`

### 3.13 总验证
- [ ] **Step 1: 未使用项归零**

Run: `npx tsc --noUnusedLocals --noUnusedParameters --noEmit`
Expected: 无输出。

- [ ] **Step 2: 全量测试仍绿**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add src
git commit -m "refactor: purge dead code and tighten types (23 unused items)"
```

---

## Task 4: 接通任务路由(runAuto)

**Files:**
- Modify: `src/core/agent.ts`、`src/cli/index.ts`

背景:TaskRouter(DIRECT/PLAN 判断)此前只在测试里出现,生产从未接线;`agent.ts` 里 `taskRouter` 字段和导入是死代码。Task 4 把路由真正接到执行路径,同时让该字段「复活」。

- [ ] **Step 1: 在 Agent 增加 `runAuto`(插在 `runPlanned` 之后,第 665 行后)**

```ts
/** 自动路由：由 TaskRouter 决定 DIRECT(单次执行)还是 PLAN(规划执行) */
async runAuto(goal: string): Promise<string | PlanExecutionResult> {
  if (!this.taskRouter) {
    this.taskRouter = new TaskRouter(this.llm);
  }
  const mode = await this.taskRouter.route(goal, this.workingMemory);
  this.logger.info("Agent", `Router decision: ${mode}`);
  if (mode === "direct") {
    return this.run(goal);
  }
  return this.runPlanned(goal);
}
```
(`PlanExecutionResult` 已在第 26 行导入;`run()` 返回 `Promise<string>`,`runPlanned()` 返回 `Promise<PlanExecutionResult>`。)

- [ ] **Step 2: CLI 默认命令改走 `runAuto`(第 163-171 行)**

将:
```ts
const result = await agent.run(task);
console.log(renderResult());
console.log(result);
const m = agent.getLastRunMetrics()?.currentSnapshot();
if (m) {
  console.log(renderMetrics(m));
}
console.log();
```
改为:
```ts
const result = await agent.runAuto(task);
if (typeof result === "string") {
  console.log(renderResult());
  console.log(result);
  const m = agent.getLastRunMetrics()?.currentSnapshot();
  if (m) {
    console.log(renderMetrics(m));
  }
} else {
  printPlanResult(result);
}
console.log();
```
(`printPlanResult` 接受 `PlanExecutionResult`,见第 419 行;REPL 路径与显式 `plan` 命令保持不变。)

- [ ] **Step 3: 编译 + 全量测试**

Run: `npx tsc --noEmit` 与 `npm test`
Expected: 全绿。

- [ ] **Step 4: 冒烟测试(可选,需网络与 .env)**

Run: `npx tsx src/cli/index.ts "cap" 2>&1 | Select-Object -First 3`
Expected: 日志出现 `Router decision: direct` 并完成执行。若缺少 API key,应先看到 Task 5 的引导提示。此步失败不影响提交(冒烟将在 W2 系统化)。

- [ ] **Step 5: 提交**

```bash
git add src/core/agent.ts src/cli/index.ts
git commit -m "feat: wire TaskRouter into runAuto for automatic DIRECT/PLAN routing"
```

---

## Task 5: CLI / UX 打磨

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: 无 API key 引导**

在 import 区之后、`program` 定义之前加:
```ts
function assertApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      renderError(
        "Missing OPENAI_API_KEY. Copy .env.example to .env and fill in your API key (DeepSeek example included)."
      )
    );
    process.exit(1);
  }
}
```
在默认命令 action 中、构造 `new OpenAIAdapter` 之前(约第 71 行附近)调用 `assertApiKey();`;在 `plan` 命令 action 中、构造 LLM 之前(第 386 行附近)同样调用一次。

- [ ] **Step 2: 失败时设置退出码**

默认 action 的 catch 块(第 172-174 行)与 `plan` action 的 catch 块(第 414-416 行)中,在 `console.log(renderError(...))` 之后各加一行 `process.exitCode = 1;`。

- [ ] **Step 3: 修掉 `saveProjectConfig` 的 `as any`(第 259 行)**

将 `saveProjectConfig({ defaultCapability: currentCapLevel as any });` 改为 `saveProjectConfig({ defaultCapability: currentCapLevel });`
Run: `npx tsc --noEmit`
Expected: 通过。若 tsc 报「string 不可赋给 CapabilityLevel」,则改为 `saveProjectConfig({ defaultCapability: currentCapLevel as CapabilityLevel });` 并在文件顶部加 `import type { CapabilityLevel } from "../capabilities.js";`(以 tsc 结果二选一)。

- [ ] **Step 4: 更新 CLI 描述**

第 47 行改为 `description("A CLI coding agent with ReAct loop, planning, memory and safety controls")`。

- [ ] **Step 5: 验证 + 提交**

Run: `npx tsc --noEmit`、`npm test`
Expected: 全绿。
```bash
git add src/cli/index.ts
git commit -m "feat(cli): api-key guidance, exit codes, typed config save, better description"
```

---

## Task 6: README 与 quickstart

**Files:**
- Create: `README.md`
- Modify: `docs/quickstart.md`

- [ ] **Step 1: 创建根目录 `README.md`**

写入以下内容(「架构速览」的 ASCII 图从 `docs/architecture.md` 复制最核心的一张,保持一致,不新画):
````markdown
# Thinking Agent

一个从零实现的 CLI 编码 Agent:ReAct 循环 + 分级审批 + 状态机与错误恢复 + 上下文工程 + 树形规划 + 信息生命周期(指令 / 知识 / 运行状态 / 检索),并用真实评估驱动优化。

## 快速开始

```bash
cp .env.example .env  # 填入 OPENAI_API_KEY(DeepSeek/OpenAI 兼容)
npm install
npm run build
npx thinking "你的任务"        # 自动路由 DIRECT/PLAN
npx thinking plan "复杂任务"   # 显式走规划
npx thinking --repl            # 交互模式
```

## 质量门

```bash
npm test          # 全量测试(脚本测试 + vitest)
npm run coverage  # 单元测试覆盖率
npm run lint      # Biome 检查
npm run check     # tsc + lint + test 一键门
```

## 架构速览

(此处粘贴 docs/architecture.md 的核心架构图,保持口径一致)

## 证据与报告

- `docs/reports/` — 真实任务基线报告与优化对比(持续更新)
- `docs/phase1-6-report*.md` — 各阶段报告
- `docs/decisions/` — ADR-001 ~ ADR-022 决策记录

## 路线图

见 `docs/roadmap.md`(Phase 7 评估 / 遥测 / 预算为当前重点)。
````

- [ ] **Step 2: 更新 `docs/quickstart.md`**

在文档开头补一段:「面向简历 / 展示:先运行 `npm test` 确认环境,再按『真实任务基线』一节,用 `docs/reports/` 中的任务集体验;`npx thinking <task>` 会自动路由任务。」措辞贴合原文档风格,不改变原有命令。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/quickstart.md
git commit -m "docs: add root README and refresh quickstart"
```

---

## Task 7: 最终验收

**Files:**
- Modify: `package.json`(version)、`src/cli/index.ts`(version)

- [ ] **Step 1: 版本号升至 0.5.0**

`package.json` 的 `"version": "0.4.6"` → `"version": "0.5.0"`;`src/cli/index.ts` 第 48 行 `.version("0.4.6")` → `.version("0.5.0")`。

- [ ] **Step 2: 一键质量门**

Run: `npm run check`
Expected: tsc 无错误、biome 检查通过、全量测试(含 vitest unit)通过。

- [ ] **Step 3: 未使用项归零复核**

Run: `npx tsc --noUnusedLocals --noUnusedParameters --noEmit`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json src/cli/index.ts
git commit -m "chore: bump to 0.5.0 after baseline hardening"
```

- [ ] **Step 5: 回写设计文档状态**

在 `docs/superpowers/specs/2026-09-19-thinking-agent-production-polish-design.md` §2.2 表格中,属于 W1 的事项(#2 #3 #4 #5 #6 #8 #9)加注 `✅ W1 已完成`;若个别项未能完成,标注 `⏳ 遗留 + 原因`(不掩盖)。此项作为一次提交:
```bash
git add docs/superpowers/specs/2026-09-19-thinking-agent-production-polish-design.md
git commit -m "docs: mark W1 items done in polish spec"
```

---

## 后续里程碑(W2-W4)计划入口

本计划只覆盖 W1 基线修复。W2(真实任务基线报告)、W3(Eval Harness / Telemetry / Budget Manager + 消融实验)、W4(优化对比 + 叙事文档)依赖真实运行结果,将在各自里程碑开始时产出独立计划文档;范围与验收见设计文档 §3.3-3.5 与 §4。每完成一个里程碑,回写设计文档状态并提交。
