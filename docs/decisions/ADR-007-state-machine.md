# ADR-007: State Machine 状态机设计

> Phase 3 | 状态：已实现

## 背景

Agent 在执行任务时需要追踪大量运行时信息：当前目标、已完成步骤、失败步骤、重试次数、涉及的文件、token 消耗。

最直接的做法是把这些信息塞进 LLM 的对话历史里。但问题：
1. 对话历史已经在膨胀（每轮 tool_call + result 都是一大段文字）
2. 这些结构化信息用自然语言表达效率极低（"你已经失败了 3 次，重试了 2 次" vs 一行状态字段）
3. LLM 不擅长精确计数（它记不清自己失败了几次）

## 决策：独立状态机，运行时状态不进 Prompt

```
Agent (ReAct 循环)
  ├── StateMachine    ← 精确追踪所有运行时状态（不进对话历史）
  ├── ErrorTaxonomy   ← 错误分类 + 恢复策略
  └── ReflectionEngine ← 反思触发判断
```

状态机只做三件事：
1. **记录** — 每次工具调用的成败、耗时、错误类型
2. **追踪** — 当前处于什么状态、重试了几次
3. **校验** — 状态转换是否合法（防止 EXECUTING → PLANNING 这种回退）

## 为什么不用其他方案

**方案 A：全塞进对话历史**
- Token 浪费：每轮重复描述状态
- LLM 计数不准："你已经失败了 3 次" — 但 LLM 可能记成 2 次
- 无法做精确的状态转换校验

**方案 B：LangGraph 风格的图状态**
- 引入图节点/边的概念，复杂度高
- 单 Agent 场景用不着多节点编排
- 学习成本和维护成本不成正比

**方案 C（选择）：轻量状态机 + 6 种状态**
- 足够表达 Agent 的生命周期
- 转换表硬编码，非法跳转直接拒绝
- 可以 snapshot() 导出给 REPL 或日志查看

## 6 种状态

```
PLANNING → EXECUTING → COMPLETED
                ↓
           REFLECTING ↔ RECOVERING
                ↓
             FAILED
```

| 状态 | 含义 | 可转换到 |
|------|------|---------|
| PLANNING | 任务刚开始 | EXECUTING, FAILED |
| EXECUTING | 正在执行 | REFLECTING, RECOVERING, COMPLETED, FAILED |
| REFLECTING | 停下来反思 | EXECUTING, RECOVERING, FAILED |
| RECOVERING | 正在执行恢复策略 | EXECUTING, REFLECTING, FAILED |
| COMPLETED | 任务完成（终态） | 无 |
| FAILED | 任务失败（终态） | 无 |

## 关键接口

```typescript
// 记录步骤
stateMachine.recordStep({ toolName, arguments, success, durationMs })
stateMachine.recordFailure({ toolName, arguments, success, errorType, durationMs })

// 状态转换（带校验）
stateMachine.transition(ExecutionStatus.REFLECTING)  // true = 合法
stateMachine.transition(ExecutionStatus.PLANNING)     // false = 非法，被拒绝

// 获取快照（只读，供外部查看）
const snapshot = stateMachine.snapshot()
// → { status, currentGoal, completedSteps, failedSteps, retryCount, ... }
```

## 踩过的坑

| 问题 | 原因 | 解决 |
|------|------|------|
| LLM 记不清失败了几次 | 自然语言不擅长精确计数 | 状态机用数字精确追踪 |
| COMPLETED 状态还能被覆盖 | 没有终态保护 | 转换表中 COMPLETED/FAILED 的可转换列表为空 |

## 关键文件

- `src/core/state-machine.ts` — 状态机实现
- `src/core/agent.ts` — Agent 循环中集成状态机
