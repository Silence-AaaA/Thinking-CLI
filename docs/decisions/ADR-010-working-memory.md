# ADR-010: Working Memory 设计

> Phase 4 | 状态：已实现

## 背景

LLM 在长对话中会"忘记"前面的关键信息。比如第 2 轮发现"package.json 有 3 个依赖"，到第 15 轮时 LLM 可能已经不记得了。

直接把所有信息塞进对话历史也不行 — 对话历史已经很长了，关键信息被淹没在大量 tool_call → result 的流水账中。

## 决策 1：独立的结构化存储，每轮注入 prompt

Working Memory 是一个独立模块，存储 5 类信息：
- `currentGoal` — 当前目标
- `findings` — 关键发现（带重要度 + 来源）
- `activeFiles` — 涉及的文件列表
- `recentErrors` — 最近错误
- `decisions` — 做过的决策

每轮调 LLM 之前，Context Assembler 会把 Working Memory 格式化后注入到消息列表中。

**为什么不用对话历史本身来"记住"？**
- 对话历史是流水账，信息密度低
- LLM 不擅长从 50 条消息中提取关键结论
- Working Memory 是"结论"，不是"过程"

## 决策 2：重要度分级

每条 finding 有 `importance: low | medium | high`。

**为什么需要分级？**
- Working Memory 有容量上限（默认 15 条）
- 超过上限时，优先移除低重要度的发现
- 避免"读了 10 个文件"把"发现了一个 bug"挤掉

## 决策 3：自动更新，不依赖 LLM

Working Memory 的更新由 Agent 主循环驱动（工具成功/失败后自动更新），不靠 LLM 自己决定"什么值得记住"。

**为什么不让 LLM 自己管理？**
- LLM 不知道什么信息对后续步骤有价值
- LLM 可能忘记更新，或者写一堆无关信息
- Agent 框架有全局视角，能做出更好的选择

## 关键文件

- `src/core/working-memory.ts` — Working Memory 实现
- `src/core/agent.ts` — Agent 循环中自动更新
