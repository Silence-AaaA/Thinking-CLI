# ADR-020: Summary Checkpoint Diff

> Phase 4.7 | 状态：已实现

## 背景

ADR-017 实现了 History Checkpoints，每次重大压缩时保存一个 summary 快照。
但目前只能"看"到单个 checkpoint 的内容，无法回答：
- v3 和 v7 的 summary 到底变了什么？
- 哪一步导致了理解的转变？
- 压缩是否丢失了关键信息？

没有 diff，checkpoint 就只是"存档"，不是"版本控制"。

## 决策

在 `HistoryCheckpointManager` 上新增 diff 能力：

```
CheckpointDiff {
  id1, id2                  // 两个 checkpoint 的 ID
  stepDelta                 // 步数差
  contextVersionDelta       // 上下文版本差
  summaryDiff               // 逐行 diff（+/- 格式）
  summary1, summary2        // 原始 summary 文本
  timestamp
}
```

两个入口方法：
- `diff(ckpt1, ckpt2)` — 比较任意两个 checkpoint
- `diffWithLatest(ckpt)` — 与最新 checkpoint 比较

## 为什么用行级 diff 而不是语义 diff

行级 diff 简单、确定性、零成本。
语义 diff（如 LLM 对比）需要额外 API 调用，且可能引入幻觉。
summary 本身是结构化文本（每行一个要点），行级 diff 已经足够直观。

如果未来需要更智能的对比，可以在行级 diff 基础上叠加 LLM 分析，
而不是替换它。

## 关键收益

- 可追溯"理解是怎么变化的"
- 可诊断"为什么 LLM 突然换策略"（对比前后 checkpoint 的 summary 差异）
- 可审计压缩质量（检查压缩是否丢失关键信息）
- 为未来 context replay 提供基础

## 关键文件

- `src/core/history-checkpoints.ts` — CheckpointDiff 接口 + diff() / diffWithLatest()
