# ADR-012: Context Assembler 设计

> Phase 4 | 状态：已实现

## 背景

Phase 1-3 的 Agent 直接把 `this.state.messages`（原始对话历史）丢给 LLM。随着对话变长，问题暴露：
1. 上下文窗口会被撞满
2. 关键信息被淹没在流水账中
3. LLM 注意力分散，决策质量下降

需要一个"组装器"，在每次调 LLM 之前重新组织消息。

## 决策：分层组装，每层有明确职责

```
┌─────────────────────────────────────────────┐
│ System Prompt        → 角色 + 规则（不变）     │
│ Working Memory       → 当前目标 + 关键发现     │
│ State Snapshot       → 状态机关键字段          │
│ Recent History       → 最近 N 轮完整对话       │
│ Summary              → 早期对话的压缩版        │
│ Retrieved Context    → [预留] 按需获取的知识    │
├─────────────────────────────────────────────┤
│ 总量必须 < 上下文窗口                          │
└─────────────────────────────────────────────┘
```

**为什么不直接用原始消息列表？**
- 原始列表是"流水账"，没有结构
- LLM 需要"先看全局（memory + state），再看细节（recent history）"
- 分层组装让每部分的优先级明确

## 为什么不选其他方案

**方案 A：只压缩历史，不加 Working Memory**
- 压缩后 LLM 知道"之前做了什么"，但不记得"发现了什么关键信息"
- Working Memory 和压缩是互补的，不是替代的

**方案 B：用 LLM 来组装上下文（智能选择放什么）**
- 每轮多一次 LLM 调用，延迟和成本都增加
- 规则组装已经足够好，不需要 LLM 来判断

**方案 C（选择）：规则驱动的分层组装**
- 快、免费、可预测
- 每层可以独立调参（recentRounds、maxFindings 等）
- 未来可以加更多层（Retrieved Context）

## 关键设计细节

### Working Memory 注入位置
放在 system prompt 之后、对话历史之前。
原因：Working Memory 是"全局视角"，应该让 LLM 最先看到。

### State Snapshot 注入
放在 Working Memory 之后。
原因：状态信息是"元数据"，优先级低于当前目标和关键发现。

### 空 Working Memory 不注入
如果 Working Memory 还没有任何内容（任务刚开始），不注入空的 "## Working Memory" 消息，避免浪费空间。

### Token 上限保护
组装后检查总 token 估算，如果超过上下文窗口限制，从最早的消息开始截断（保留 system + memory）。

## 关键文件

- `src/core/context-assembler.ts` — Context Assembler 实现
- `src/core/agent.ts` — Agent 循环中调用 assembler
- `src/core/working-memory.ts` — Working Memory（被依赖）
- `src/core/history-compressor.ts` — History Compressor（被依赖）
- `src/core/state-machine.ts` — State Machine（被依赖）
