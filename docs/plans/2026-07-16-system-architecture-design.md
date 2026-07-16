# Thinking Agent — 系统架构设计

> 版本: v2.0 | 日期: 2026-07-16
> 基于"能力域"模型重新组织，替代原有的"问题驱动"路线

---

## 一、设计理念

### 从"解决问题"到"构建能力"

早期版本按问题排 Phase：Phase 3 解决审批、Phase 6 解决压缩……
问题是：问题之间没有结构性关系，解决一个不会帮助解决下一个。

新框架按**能力域**组织：每个 Phase 构建一个独立的能力层，
层与层之间有明确的依赖关系，上层依赖下层。

```
用户
 │
 ▼
┌─────────────────────────────────────────────┐
│  Phase 5: Planning                          │  ← 复杂任务分解
│  (Planner / Executor / Replan)              │
├─────────────────────────────────────────────┤
│  Phase 3: Execution Engine                  │  ← 可靠执行
│  (State Machine / Reflection / Recovery)    │
├─────────────────────────────────────────────┤
│  Phase 4: Context Engineering               │  ← 信息管理
│  (Compression / Working Memory / Retrieval) │
├─────────────────────────────────────────────┤
│  Phase 2: Tool System                       │  ← 能力边界
│  (Schema / Validation / Observation)        │
├─────────────────────────────────────────────┤
│  Phase 1: Agent Loop                        │  ← 基础循环
│  (LLM / Tool / Loop Control)               │
├─────────────────────────────────────────────┤
│  Phase 6: Memory                            │  ← 横切关注点
│  Phase 7: Reliability                       │  ← 横切关注点
│  Phase 8: Production                        │  ← 横切关注点
└─────────────────────────────────────────────┘
```

### 四个关键词

整个框架围绕 4 个核心概念展开：

| 关键词 | 含义 | 对应 Phase |
|--------|------|-----------|
| **State** | Agent 的运行时状态，不进 Prompt | Phase 3 |
| **Context** | 送给 LLM 的信息，需要精心管理 | Phase 4 |
| **Observation** | 工具原始输出的结构化提取 | Phase 2 |
| **Evaluation** | 衡量 Agent 行为好不好 | Phase 7 |

---

## 二、Phase 总览

### Phase 1: Agent Loop — 基础循环

**能力**: LLM 调用 → 工具选择 → 执行 → 反馈 → 循环

**子模块**:
- LLM Adapter（模型调用抽象）
- Loop Controller（循环控制、最大步数）
- Doom Loop Detector（重复失败检测）

**已完成**: ✅ 全部完成

**文件**:
- `src/core/agent.ts` — ReAct 循环
- `src/llm/openai-adapter.ts` — LLM 适配器
- `src/llm/types.ts` — 接口定义

---

### Phase 2: Tool System — 能力边界

**能力**: 工具定义、注册、校验、风险评估、观察提取

**子模块**:
- Tool Schema（JSON Schema 定义）
- Tool Registry（注册与发现）
- Parameter Validation（参数校验）
- Risk Assessment（风险评估）✅
- **Observation Layer（观察层）** ⬜ ← 新增

**Observation 层设计**:

```
Tool 原始输出（可能 2000 行日志）
         ↓
   Observation Layer
   ├─ 提取关键信息
   ├─ 结构化为 { summary, details, errors, metrics }
   └─ 只把 Observation 送给 LLM
```

**为什么需要 Observation？**

LLM 不应该看工具原始输出。例如 `npm test` 输出 3000 行，
LLM 只需要看到：{ passed: 47, failed: 3, first_failure: "test-auth.ts:42" }

**文件**:
- `src/tools/registry.ts` — 注册表 ✅
- `src/tools/types.ts` — 接口 ✅
- `src/core/risk-assessor.ts` — 风险评估 ✅
- `src/core/approval-gateway.ts` — 审批网关 ✅
- `src/core/observation.ts` — 观察层 ⬜

---

### Phase 3: Execution Engine — 可靠执行

**能力**: 状态管理、错误恢复、反思机制

**子模块**:
- **State Machine（状态机）** ⬜
- **Error Taxonomy（错误分类）** ⬜
- **Recovery Strategies（恢复策略）** ⬜
- **Reflection（反思机制）** ⬜

**State Machine 设计**:

```
AgentState {
  // 不进 Prompt 的运行时状态
  currentGoal: string
  currentStep: number
  completedSteps: string[]
  failedSteps: Array<{ step, error, retries }>
  activeFiles: string[]        // 当前在改的文件
  budget: { tokens, cost, time }
  approvalState: Map<toolCallId, decision>
  executionStatus: "running" | "paused" | "failed" | "done"
}
```

**Error Taxonomy 设计**:

| 错误类型 | 示例 | 恢复策略 |
|----------|------|----------|
| Tool Error | 文件不存在 | 换路径 / 问用户 |
| Validation Error | 参数格式错 | 让 LLM 重新生成参数 |
| Permission Error | 权限不足 | 申请审批 |
| Timeout | 命令超时 | 缩小范围重试 |
| Rate Limit | 429 | 指数退避 |
| Context Overflow | token 超限 | 压缩上下文 |
| Network Error | 连接失败 | 重试（有限次） |
| Schema Error | JSON 解析失败 | 重新生成 |
| Hallucination | 编造不存在的文件 | Observation 层校验 |

**Reflection 设计**:

不是每次都反思。触发条件：
- 同一目标连续失败 2 次
- 工具返回与预期不符的结果
- 超过预设步数还没完成

反思输出：
```
{
  "reflection": "I've tried editing the file twice but tests keep failing.",
  "diagnosis": "The issue is likely not in the file I'm editing.",
  "new_strategy": "I should read the test file first to understand what's expected."
}
```

**文件**:
- `src/core/state-machine.ts` ⬜
- `src/core/error-taxonomy.ts` ⬜
- `src/core/recovery.ts` ⬜
- `src/core/reflection.ts` ⬜

---

### Phase 4: Context Engineering — 信息管理

**能力**: 送给 LLM 的信息精心管理，不是全部塞进去

**核心理念**: 不是"压缩"，是"工程"

```
┌──────────────────────────────────────────┐
│           Context 组成                    │
│                                          │
│  System Prompt     ← 角色 + 规则         │
│  Working Memory    ← 当前任务的关键信息   │
│  Scratchpad        ← 中间计算/推理结果    │
│  Recent History    ← 最近几轮对话         │
│  Summary           ← 早期对话的压缩版     │
│  Retrieved Context ← 按需检索的文件/知识  │
│  State Snapshot    ← 状态机的关键字段     │
│                                          │
│  总量必须 < 上下文窗口                    │
└──────────────────────────────────────────┘
```

**子模块**:
- **Context Assembler（上下文组装器）** ⬜
- **History Compressor（历史压缩）** ⬜
- **Working Memory（工作记忆）** ⬜
- **Retrieval（按需检索）** ⬜

**文件**:
- `src/core/context-assembler.ts` ⬜
- `src/core/history-compressor.ts` ⬜
- `src/core/working-memory.ts` ⬜

---

### Phase 5: Planning — 任务规划

**能力**: 复杂任务分解、执行监控、动态重规划

**子模块**:
- **Task Planner（任务分解）** ⬜
- **Step Executor（步骤执行）** ⬜
- **Dynamic Replanner（动态重规划）** ⬜

**三层规划**:

```
Task Planning（用户任务 → 步骤列表）
    ↓
Execution Planning（每个步骤 → 工具调用序列）
    ↓
Dynamic Replanning（执行中发现问题 → 调整计划）
```

**文件**:
- `src/core/task-planner.ts` ⬜
- `src/core/step-executor.ts` ⬜
- `src/core/replanner.ts` ⬜

---

### Phase 6: Memory — 记忆系统

**能力**: 会话内记忆、长期记忆、项目记忆

**三层记忆**:

```
Session Memory（当前对话，自动管理）
    ↓
Project Memory（当前项目，如 AGENTS.md）
    ↓
Long-term Memory（跨项目，持久化存储）
```

**文件**:
- `src/memory/session.ts` ⬜
- `src/memory/project.ts` ⬜
- `src/memory/long-term.ts` ⬜

---

### Phase 7: Reliability — 可靠性

**能力**: 评估、观测、预算管理

**子模块**:
- **Evaluation（评估体系）** ⬜
- **Telemetry（观测系统）** ⬜
- **Budget Manager（预算管理）** ⬜

**评估体系**:

| 指标 | 含义 |
|------|------|
| Success Rate | 任务完成率 |
| Tool Accuracy | 工具选择正确率 |
| Loop Count | 平均循环次数 |
| Cost Per Task | 每任务平均成本 |
| Latency | 平均响应时间 |

**文件**:
- `src/reliability/evaluator.ts` ⬜
- `src/reliability/telemetry.ts` ⬜
- `src/reliability/budget.ts` ⬜

---

### Phase 8: Production — 生产级

**能力**: MCP 集成、安全增强、多 Agent

**子模块**:
- MCP Server 集成
- 安全沙盒增强
- 多 Agent 协作
- 插件系统

**文件**:
- `src/production/mcp.ts` ⬜
- `src/production/sandbox.ts` ⬜
- `src/production/multi-agent.ts` ⬜

---

## 三、已有代码映射

| 已有文件 | 对应新 Phase | 状态 |
|----------|-------------|------|
| `src/core/agent.ts` | Phase 1 | ✅ |
| `src/llm/openai-adapter.ts` | Phase 1 | ✅ |
| `src/tools/*.ts` | Phase 2 | ✅ |
| `src/core/risk-assessor.ts` | Phase 2 | ✅ |
| `src/core/approval-gateway.ts` | Phase 2 | ✅ |
| `src/utils/logger.ts` | Phase 7 (Telemetry) | ✅ 基础版 |
| `src/cli/index.ts` | Phase 8 (CLI) | ✅ |

---

## 四、实施顺序

```
当前进度：Phase 1-2 基本完成

下一步：
Phase 2 补充：Observation Layer（观察层）
Phase 3 核心：State Machine + Error Taxonomy + Reflection
Phase 4 核心：Context Assembler + Working Memory
Phase 5 核心：Task Planner + Dynamic Replan
Phase 6 核心：Session Memory + Project Memory
Phase 7 核心：Telemetry + Evaluation
Phase 8 核心：MCP + 安全增强
```

每个 Phase 完成后都可以独立运行、独立测试、独立增强。
