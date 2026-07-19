# 决策记录索引

> 每个 Phase 的关键设计决策、为什么这么做、踩过什么坑。
> 只记录已实现的内容，不记录规划中的。

## Phase 1: Agent Loop

| 文件 | 决策 |
|------|------|
| [ADR-001](./ADR-001-react-loop.md) | ReAct 循环的实现方式 |
| [ADR-002](./ADR-002-loop-control.md) | 循环控制与 Doom Loop 检测 |
| [ADR-003](./ADR-003-llm-adapter.md) | LLM 适配层抽象与重试策略 |

## Phase 2: Tool System

| 文件 | 决策 |
|------|------|
| [ADR-004](./ADR-004-tool-design.md) | 工具接口设计与 Token 经济学 |
| [ADR-005](./ADR-005-approval-system.md) | 分级审批系统 |
| [ADR-006](./ADR-006-observation.md) | Observation Layer 设计 |

## Phase 3: Execution Engine

| 文件 | 决策 |
|------|------|
| [ADR-007](./ADR-007-state-machine.md) | 状态机设计：6 种状态 + 转换校验 |
| [ADR-008](./ADR-008-error-taxonomy.md) | 错误分类与恢复策略设计 |
| [ADR-009](./ADR-009-reflection.md) | 反思机制：数据驱动触发 + 结构化反思 |

## Phase 4: Context Engineering

| 文件 | 决策 |
|------|------|
| [ADR-010](./ADR-010-working-memory.md) | Working Memory：结构化关键信息 + 重要度分级 |
| [ADR-011](./ADR-011-history-compressor.md) | History Compressor：规则压缩 vs LLM 压缩 |
| [ADR-012](./ADR-012-context-assembler.md) | Context Assembler：分层组装 + token 上限保护 |

## Phase 4.5: Context Engine Upgrade

| 文件 | 决策 |
|------|------|
| [ADR-013](./ADR-013-structured-observation.md) | Observation 结构化载荷设计 |
| [ADR-014](./ADR-014-working-memory-v2.md) | Working Memory v2（可衰减、可溯源） |
| [ADR-015](./ADR-015-context-assembler-v2.md) | Context Assembler v2（可解释组装） |

## Phase 4.6: Context Engine Runtime

| 文件 | 决策 |
|------|------|
| [ADR-016](./ADR-016-runtime-metrics.md) | Runtime Metrics 设计 |
| [ADR-017](./ADR-017-history-checkpoints.md) | History Checkpoints 设计 |
| [ADR-018](./ADR-018-context-changelog.md) | Context Changelog 设计 |

## Phase 4.7: State Runtime Enhancement

| 文件 | 决策 |
|------|------|
| [ADR-019](./ADR-019-runtime-snapshot.md) | Runtime Snapshot：checkpoint / resume / replay |
| [ADR-020](./ADR-020-checkpoint-diff.md) | Summary Checkpoint Diff：比较 checkpoint 之间变化 |
| [ADR-021](./ADR-021-run-report.md) | Run Report JSON 导出：标准化运行报告 |
