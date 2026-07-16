# ADR-002: 循环控制与 Doom Loop 检测

> Phase 1 | 状态：已实现

## 背景

ReAct 循环最大的风险是**停不下来**。两种情况：

1. **LLM 不知道该停了** — 读完文件后又去读另一个，读完又读……
2. **Doom Loop** — 工具连续失败，LLM 不断重试同样的操作

## 决策 1：停止条件

三重停止机制：

| 层级 | 机制 | 触发条件 |
|------|------|----------|
| LLM 自主停止 | tool_calls 为空 | LLM 认为任务完成，直接返回答案 |
| Prompt 规则 | 系统提示词 | "STOP when the task is done" |
| 兜底 | maxIterations | 达到上限后让 LLM 做总结性回复 |

## 决策 2：Doom Loop 检测器

独立的 `DoomLoopDetector` 类，检测逻辑：

```
同一工具 + 同样参数 + 连续失败 N 次 → Doom Loop
```

触发后注入一条系统消息：
```json
{
  "error": "Doom loop detected",
  "instruction": "STOP. Do not retry this tool. Tell the user what went wrong."
}
```

## 踩过的坑

**问题**：最初只靠 maxIterations 兜底，没有 Doom Loop 检测。
结果：Agent 读一个不存在的文件，失败后换个路径再读，再换再读……直到用完 20 步。

**解决**：DoomLoopDetector 按"工具名+参数"做指纹匹配，不是按工具名。
因为"读 fileA 失败后读 fileB"是正常探索，不算 doom loop；
但"读 fileA 失败后又读 fileA"才是 doom loop。

## 关键文件

- `src/core/agent.ts` — DoomLoopDetector 类
