# ADR-001: ReAct 循环的实现方式

> Phase 1 | 状态：已实现

## 背景

Agent 的核心是一个循环：LLM 思考 → 决定调工具 → 执行 → 把结果喂回 LLM → 继续思考。

问题是：这个循环怎么写？

## 决策

选择了**单 Agent + while 循环**的方式，而不是更复杂的图结构（如 LangGraph）。

```
while (step < maxIterations) {
  response = llm.chat(messages, tools)
  if (no tool_calls) return response.content  // 任务完成
  for (toolCall in response.tool_calls) {
    result = tools.execute(toolCall)
    messages.push(tool result)
  }
}
```

## 为什么这么做

1. **简单可理解** — 一个 while 循环就能跑通 ReAct，不需要引入图、节点、边等抽象
2. **学习价值** — 先理解最简形式，才能理解为什么后面需要 State Machine
3. **足够用** — 对于 CLI Agent，单 Agent 循环已经能处理大多数任务

## 为什么不选其他方案

- **LangGraph 风格的图结构**：过度抽象，学习成本高，MVP 阶段不需要
- **递归调用**：栈溢出风险，调试困难
- **事件驱动**：复杂度高，适合多 Agent 场景，单 Agent 没必要

## 关键文件

- `src/core/agent.ts` — ReAct 循环主逻辑
