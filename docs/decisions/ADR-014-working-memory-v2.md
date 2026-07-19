# ADR-014: Working Memory v2（可衰减、可溯源）

> Phase 4.5 | 状态：已实现

## 背景

Phase 4 的 Working Memory 解决了“有没有记忆”的问题，但没解决：
- 谁决定某条信息该记住？
- 信息老了怎么消失？
- 为什么这条信息还在？

## 决策

引入 memory entry 结构化字段：

- `source`: 谁写入（tool / observation / reflection / user）
- `confidence`: 置信度
- `strength`: 强度（可衰减）
- `lastSeenStep`: 最后一次相关步骤
- `importance`: 重要度
- `tags`: 可用于检索/覆盖

### 演化规则

1. 每步执行 `tickStep()` 进行 decay
2. 新证据可 `reinforceByFile()` 升权
3. 失败证据可 `demoteByFile()` 降权
4. 同类记忆可被新证据覆盖/增强
5. 低强度记忆自动淘汰

## 为什么不继续用简单列表

简单列表只能做到 FIFO/LRU，无法表达：
- 这条记忆为什么重要
- 它是否已过期
- 它的来源是否可靠

## 关键收益

- Working Memory 从“记录器”变成“演化记忆系统”
- 与 Observation severity/confidence 联动
- 为未来 Replay / Checkpoint / Provenance 打基础

## 关键文件

- `src/core/working-memory.ts`
- `src/core/agent.ts`
