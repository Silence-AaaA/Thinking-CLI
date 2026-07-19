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

## 三、任务清单

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
- `plan(goal: string, context: WorkingMemorySnapshot): TaskPlan`
  - 调用 LLM 把目标分解为步骤
  - 注入 Working Memory 作为规划上下文
  - 输出结构化的 TaskPlan

- `replan(plan: TaskPlan, failure: string, context: WorkingMemorySnapshot): TaskPlan`
  - 根据失败信息调整计划
  - 保留已完成的步骤
  - 重新规划未完成的部分

**ADR**: ADR-022（待创建）

---

### 5.2 Step Executor（步骤执行器）

**文件**: `src/core/step-executor.ts`

**职责**:
- 拿到 TaskPlan，按顺序（或依赖关系）执行每个 Step
- 每个 Step 调用 Agent.run()，但注入 Step 级别的上下文
- 管理 Step 之间的状态传递

**核心方法**:
- `execute(plan: TaskPlan, agent: Agent): TaskPlan`
  - 遍历 pending 步骤
  - 每步构造 Agent.run() 的 goal（包含步骤描述 + 前序步骤结果）
  - 更新步骤状态

- `buildStepContext(step: TaskStep, plan: TaskPlan, memory: WorkingMemory): string`
  - 为当前步骤构造上下文：
    - 原始目标
    - 前序步骤的结果
    - 当前步骤的具体要求
    - Working Memory 中的相关 findings

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

## 四、实施顺序

```
5.1 Task Planner         ← 先做（核心能力）
5.2 Step Executor        ← 依赖 5.1
5.3 Dynamic Replanner    ← 依赖 5.1 + 5.2
5.4 CLI 集成             ← 依赖 5.1-5.3
5.5 集成测试             ← 依赖 5.1-5.4
```

建议每次完成一个子任务后立即测试，不要等到全部完成。

---

## 五、与后续 Phase 的关系

| Phase 5 产出 | Phase 6 (Memory) | Phase 7 (Reliability) | Phase 8 (Production) |
|-------------|------------------|----------------------|---------------------|
| TaskPlan | 跨会话保存计划 | 评估计划质量 | 多 Agent 分工 |
| Step 结果 | 长期记忆步骤经验 | 评估步骤成功率 | 步骤级权限控制 |
| Replan 记录 | 记忆"什么情况下需要 replan" | 评估 replan 频率 | 分布式步骤执行 |
