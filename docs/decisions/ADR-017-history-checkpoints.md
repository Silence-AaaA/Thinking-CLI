# ADR-017: History Checkpoints 设计

> Phase 4.6 | 状态：已实现

## 背景

如果只保留一个 current summary，一旦 summary 总结错了，旧证据就没了。  
这会导致：
- 无法回看“之前的理解是什么”
- 无法 replay 某个阶段
- 无法对比“上下文变化”

## 决策

在发生重大历史压缩时，保存一个 checkpoint：
- step
- contextVersion
- summary
- compressedCount
- sourceRoundCount

## 为什么不每次 assemble 都存 full snapshot

成本太高。  
checkpoint 是“关键节点快照”，不是“每步全量备份”。

## 关键收益

- 支持历史回看
- 支持 summary versioning
- 为未来 replay / rollback 提供基础

## 关键文件

- `src/core/history-checkpoints.ts`
- `src/core/context-assembler.ts`
