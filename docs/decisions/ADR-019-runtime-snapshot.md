# ADR-019: Runtime Snapshot — checkpoint / resume / replay

> Phase 4.7 | 状态：已实现

## 背景

Agent 运行过程中，如果遇到长时间任务、外部中断、或者需要"先做到一半再回来"，
目前只能重新开始。丢失了所有中间状态：
- 已完成的步骤记录
- 状态机状态（当前处于哪个阶段、重试了几次）
- Working Memory（已积累的 findings、active files、errors）
- Reflection Engine 状态（连续失败计数、上次失败的工具）

没有 snapshot，就无法做到 checkpoint / resume / replay。

## 决策

在 Agent 层引入 `RuntimeSnapshot` 接口，聚合四个子系统的状态快照：

```
RuntimeSnapshot {
  agentState       // messages, currentStep, totalTokens, toolCallHistory
  stateMachine     // status, goal, steps, retries, reflections, budget
  workingMemory    // findings, activeFiles, errors, decisions, version
  reflection       // consecutiveFailures, lastToolName, recoveryFailureCount
  timestamp
}
```

每个子系统实现自己的序列化/反序列化：
- `StateMachine.loadSnapshot(snap)` — 恢复状态机全量状态
- `WorkingMemory.loadSnapshot(snap)` — 恢复工作记忆
- `ReflectionEngine.toJSON()` / `loadJSON()` — 反思引擎序列化

Agent 暴露两个方法：
- `snapshot()` — 创建当前运行时快照
- `restore(snap)` — 从快照恢复状态

## 为什么不每次都自动存 full snapshot

成本与收益的平衡。
- snapshot 是 O(n) 深拷贝，每步都做会增加内存和 GC 压力
- 由调用方决定何时 checkpoint（关键节点、定时、手动）
- 这是"能力"，不是"策略"

## 为什么不只存 messages

messages 只是对话历史，不包含：
- 状态机状态（当前处于 planning/executing/reflecting 哪个阶段）
- Working Memory 的衰减权重和来源追踪
- Reflection Engine 的连续失败计数

只恢复 messages 会导致 Agent "失忆"——记得说过什么，但忘了学到什么。

## 关键收益

- 支持长时间任务的中断恢复
- 支持 "做到一半暂停，稍后继续" 的工作流
- 为未来 replay（从某个 checkpoint 重新执行）提供基础
- 为并行实验（同一 checkpoint 分叉尝试不同策略）提供基础

## 关键文件

- `src/core/agent.ts` — RuntimeSnapshot 接口 + snapshot() / restore()
- `src/core/state-machine.ts` — loadSnapshot()
- `src/core/working-memory.ts` — loadSnapshot()
- `src/core/reflection.ts` — toJSON() / loadJSON()
