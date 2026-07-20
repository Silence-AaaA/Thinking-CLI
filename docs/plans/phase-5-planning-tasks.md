# Phase 5: Planning — 任务规划实施计划

> 日期: 2026-07-19
> 前置条件: Phase 1-4.7 全部完成 ✅
> 目标: 让 Agent 能处理"帮我重构这个模块"级别的复杂任务

---

## 一、问题背景

当前 Agent 只能处理"一步到位"的任务：
- 用户说"读这个文件" → 直接读 → 完成
- 用户说"你好" → 直接回答 → 完成

但对于：
- "帮我给这个项目添加单元测试"
- "重构 state-machine，把状态转换抽成独立模块"
- "排查为什么 context assembler 在大项目下会丢消息"

这些任务需要：分解 → 规划 → 逐步执行 → 遇到问题调整计划 → 最终完成。

---

## 二、架构设计

### 三层规划模型

```
用户: "帮我给 working-memory 添加单元测试"

Layer 1: Task Planning（任务分解）
  ├── Step 1: 分析 working-memory 的公开接口
  ├── Step 2: 确定需要覆盖的测试场景
  ├── Step 3: 编写测试文件
  ├── Step 4: 运行测试，确保全部通过
  └── Step 5: 检查覆盖率，补充遗漏

Layer 2: Execution Planning（每步 → 工具调用）
  Step 1 细化:
    → read_file(working-memory.ts, start=1, end=50)  // 看接口
    → grep("export class WorkingMemory", src/)       // 找所有导出
    → file_summary(working-memory.ts)                // 看整体结构

Layer 3: Dynamic Replanning（执行中调整）
  Step 3 执行时发现: 测试框架未安装
    → 插入新步骤: "安装 vitest"
    → 重新规划 Step 3-5
```

### 与现有系统的关系

```
TaskPlanner（新）
    ↓ 生成步骤列表
Agent.run()（现有，Phase 1）
    ↓ 每个步骤用现有 ReAct 循环执行
StateMachine（现有，Phase 3）追踪整体进度
ReflectionEngine（现有，Phase 3）触发时可能触发 replan
WorkingMemory（现有，Phase 4）跨步骤保持上下文
```

关键设计原则：
- TaskPlanner 不替代 Agent 的 ReAct 循环，而是在它之上
- 每个 Step 仍然是一次 Agent.run() 调用
- Replanner 在 Step 失败或 Reflection 触发时介入

---

## 三、Working Memory 注入方案

### 设计原则

**WorkingMemory 提供两种格式化方法，面向不同场景：**

| 方法 | 场景 | 内容 |
|------|------|------|
| `formatForLLM()` | ReAct 执行时 | 全量输出（所有 findings、strength/confidence 数值） |
| `formatForPlanning()` | Task 规划时 | 精简输出（只取 high/medium findings，过滤 strength < 5 的噪声） |

两个方法由 WorkingMemory 自己维护，不存在"两处提取同一数据"的问题。

### Task Planner 的注入方式

```typescript
class TaskPlanner {
  async plan(goal: string, memory: WorkingMemory): Promise<TaskPlan> {
    const messages: Message[] = [
      // 1. 规划专用 system prompt（告诉 LLM 你是在分解任务，不是在执行）
      { role: "system", content: PLANNING_SYSTEM_PROMPT },

      // 2. Working Memory 的规划版本（已过滤噪声）
      { role: "user", content: memory.formatForPlanning() },
      { role: "assistant", content: "Context noted. I will create a step-by-step plan." },

      // 3. 用户目标 + 规划指令
      { role: "user", content: `## Task\n${goal}\n\nBreak this into concrete, ordered steps. Each step should be completable by a single agent run.` },
    ];

    const response = await this.llm.chat(messages, []);
    return this.parsePlan(response.content, goal);
  }
}
```

### formatForPlanning() vs formatForLLM() 对比

```
formatForLLM() 输出：                          formatForPlanning() 输出：
─────────────────────                          ──────────────────────────
## Working Memory                              ## Working Memory (Planning Context)
Version: 3                                     **Current Goal**: 添加单元测试
**Goal**: 添加单元测试                         **Key Findings**:
**Active Files**: src/core/wm.ts                 - [high|src=grep] 12 public methods
**Key Findings**:                                - [medium|src=read] snapshot() returns ...
  - [high|str=15|conf=0.90|src=grep|step=2]   **Active Files**: src/core/wm.ts
  - [medium|str=9|conf=0.78|src=read|step=1]  **Previous Decisions**:
  - [low|str=3|conf=0.60|src=tool|step=1]       - 使用 vitest
  - [low|str=2|conf=0.55|src=tool|step=1]     **Known Issues**:
**Recent Errors**:                               - grep: file_not_found (test/)
  - grep: file_not_found
**Decisions**:
  - 使用 vitest

区别：
- formatForPlanning 过滤了 strength < 5 和 importance=low 的 findings
- formatForPlanning 去掉了 strength/confidence 数值（规划不需要）
- formatForPlanning 去掉了 Version（规划不需要）
```

### Step Executor 的注入方式

Step Executor 不需要自己注入 Working Memory。
它调用 `agent.run(stepGoal)`，Agent.run() 内部的 ContextAssembler 会自动注入 `formatForLLM()`（完整版本）。

```typescript
class StepExecutor {
  async executeStep(step: TaskStep, plan: TaskPlan, agent: Agent): Promise<string> {
    // 构造步骤级别 goal
    const stepGoal = this.buildStepGoal(step, plan);

    // Agent.run() 内部自动通过 ContextAssembler 注入完整 WM
    const result = await agent.run(stepGoal);

    return result;
  }

  private buildStepGoal(step: TaskStep, plan: TaskPlan): string {
    // 只包含：Overall Goal + 前序结果 + 当前步骤
    // 不注入 WM（Agent.run 内部会做）
    ...
  }
}
```

### 两层注入总结

```
┌─────────────────────────────────────────────────┐
│ 规划阶段（TaskPlanner.plan）                      │
│                                                  │
│ memory.formatForPlanning()  → 精简 WM            │
│ + PLANNING_SYSTEM_PROMPT    → 规划行为指令         │
│ + goal + 规划指令                                 │
│                                                  │
│ 目的：让 LLM 知道上下文，分解任务为步骤            │
└─────────────────────────────────────────────────┘
          ↓ 生成 TaskPlan
┌─────────────────────────────────────────────────┐
│ 执行阶段（Agent.run 每个 step）                   │
│                                                  │
│ ContextAssembler 自动注入:                        │
│   memory.formatForLLM()    → 完整 WM             │
│   + state snapshot          → 执行状态             │
│   + recent history          → 对话历史             │
│                                                  │
│ 目的：让 Agent 有完整信息来执行每步               │
└─────────────────────────────────────────────────┘
```

## 四、任务清单

### 5.1 Task Planner（任务分解器）

**文件**: `src/core/task-planner.ts`

**接口设计**:
```typescript
interface TaskStep {
  id: number;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "skipped";
  dependencies: number[];     // 依赖哪些 step 先完成
  result?: string;            // 执行结果摘要
  retryCount: number;
}

interface TaskPlan {
  goal: string;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  version: number;            // replan 时递增
}
```

**核心方法**:
- `plan(goal: string, memory: WorkingMemory): TaskPlan`
  - 构建规划专用上下文（system prompt + formatForLLM + buildPlanningPrompt）
  - 调用 LLM 分解任务
  - 解析返回的结构化步骤列表
  - 输出 TaskPlan

- `replan(plan: TaskPlan, failure: string, memory: WorkingMemory): TaskPlan`
  - 注入失败信息 + 当前 WM 状态
  - 保留已完成步骤，重新规划后续步骤

- `buildPlanningPrompt(goal: string, memory: WorkingMemory): string`
  - 从 WM snapshot 提取：activeFiles、high-strength findings、decisions、errors
  - 过滤噪声（只取 importance != low 且 strength >= 5）
  - 组装成规划提示

**ADR**: ADR-022（待创建）

---

### 5.2 Step Executor（步骤执行器）

**文件**: `src/core/step-executor.ts`

**职责**:
- 拿到 TaskPlan，按顺序（或依赖关系）执行每个 Step
- 每个 Step 调用 Agent.run()，注入步骤级别的上下文
- 管理 Step 之间的状态传递

**核心方法**:
- `execute(plan: TaskPlan, agent: Agent): TaskPlan`
  - 遍历 pending 步骤
  - 每步构造 Agent.run() 的 goal（包含 Overall Goal + 前序结果 + 当前步骤）
  - Agent.run() 内部自动通过 ContextAssembler 注入 Working Memory
  - 更新步骤状态

- `buildStepContext(step: TaskStep, plan: TaskPlan, memory: WorkingMemory): string`
  - Overall Goal
  - 已完成步骤及结果
  - 当前步骤描述

**ADR**: ADR-023（待创建）

---

### 5.3 Dynamic Replanner（动态重规划器）

**文件**: `src/core/replanner.ts`

**触发条件**:
1. Step 执行失败且重试耗尽
2. ReflectionEngine 触发反思
3. 执行中发现新信息（如缺少依赖）需要调整后续计划

**核心方法**:
- `shouldReplan(plan: TaskPlan, step: TaskStep, reflection?: ReflectionResult): boolean`
- `replan(plan: TaskPlan, reason: string, newInfo: string): TaskPlan`

**Replan 策略**:
- 保守策略：只调整失败步骤的后续步骤
- 激进策略：重新规划整个计划（保留已完成步骤）
- 放弃策略：连续 3 次 replan → 标记任务失败

**ADR**: ADR-024（待创建）

---

### 5.4 CLI 集成

**文件**: `src/cli/index.ts`（修改）

**改动**:
- 检测用户输入是否为复杂任务（多步骤）
- 如果是，走 TaskPlanner → StepExecutor 流程
- 如果不是，走现有的 Agent.run() 直接执行
- 输出计划进度（Step 1/5 ✅ → Step 2/5 🔄 → ...）

**判断逻辑**:
- 简单任务：单步可完成（读文件、搜索、回答问题）
- 复杂任务：需要多步协作（添加测试、重构、调试、创建功能）

---

### 5.5 集成测试

**文件**: `src/test-phase5.ts`（新增）

**测试场景**:
1. 简单任务不走规划流程（回归测试）
2. 复杂任务正确分解为多个步骤
3. 步骤失败时触发 replan
4. 跨步骤 Working Memory 正确传递
5. Run Report 包含 planning 相关指标

---

## 五、实施顺序

```
5.1 Task Planner         ← 先做（核心能力）
5.2 Step Executor        ← 依赖 5.1
5.3 Dynamic Replanner    ← 依赖 5.1 + 5.2
5.4 CLI 集成             ← 依赖 5.1-5.3
5.5 集成测试             ← 依赖 5.1-5.4
```

建议每次完成一个子任务后立即测试，不要等到全部完成。

---

## 六、与后续 Phase 的关系

| Phase 5 产出 | Phase 6 (Memory) | Phase 7 (Reliability) | Phase 8 (Production) |
|-------------|------------------|----------------------|---------------------|
| TaskPlan | 跨会话保存计划 | 评估计划质量 | 多 Agent 分工 |
| Step 结果 | 长期记忆步骤经验 | 评估步骤成功率 | 步骤级权限控制 |
| Replan 记录 | 记忆"什么情况下需要 replan" | 评估 replan 频率 | 分布式步骤执行 |

