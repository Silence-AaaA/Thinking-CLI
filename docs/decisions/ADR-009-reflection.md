# ADR-009: Reflection 反思机制设计

> Phase 3 | 状态：已实现

## 背景

人类开发者遇到连续失败时会停下来想一想："我是不是方向错了？" 但 LLM 天然不擅长这个 — 它只会一条路走到黑，或者盲目重试。

Phase 1 的 Doom Loop Detector 只做了一件事：检测重复失败然后强制停止。但它不引导 LLM 换策略，只是告诉它"别再试了"。

需要一个更智能的机制：不是"停下来"，而是"停下来想想，然后换条路"。

## 决策 1：数据驱动触发，不靠 LLM 自己判断

三种触发条件全部由外部数据判断：

| 触发条件 | 阈值 | 为什么不让 LLM 自己反思 |
|---------|------|----------------------|
| CONSECUTIVE_FAILURES | 同一工具失败 2 次 | LLM 记不清自己失败了几次 |
| TOO_MANY_STEPS | 总步数 > 15 | LLM 没有全局视角，不知道自己已经走了多远 |
| RECOVERY_EXHAUSTED | 恢复策略失败 3 次 | LLM 不知道恢复策略的存在 |

**关键设计**：反思是"推"给 LLM 的，不是 LLM "拉"的。Agent 框架检测到问题 → 主动注入反思 prompt → LLM 被迫思考。

## 决策 2：反思 prompt 的结构化格式

不是简单说"你失败了，请换策略"，而是要求 LLM 按固定格式输出：

```
## ⚠️ REFLECTION REQUIRED

**Trigger**: consecutive_failures
**Current goal**: read config file
**Failed steps**: 2
**Recent failures**:
  - Step 3: read_file → tool_error
  - Step 4: read_file → tool_error

**You MUST respond with a reflection in this format**:
REFLECTION:
  Analysis: <what went wrong and why>
  Diagnosis: <root cause>
  New Strategy: <what you will do differently>

**Suggested direction**: Try listing the directory first to find the correct file path
```

**为什么要求固定格式？**
- LLM 在自由文本中反思容易变成"我会努力的"这种空话
- 固定格式强制它输出可操作的信息：分析、诊断、新策略
- "Suggested direction" 给一个起点，避免反思完还是不知道干什么

## 决策 3：反思后的恢复机制

反思不是终点，反思后要自动切换到恢复状态：

```
EXECUTING（连续失败）
  → REFLECTING（注入反思 prompt）
  → EXECUTING（LLM 按新策略执行）
```

如果新策略也失败了，再次触发反思 → 再次注入 prompt → 但这次 prompt 里包含"你已经反思过了"的信息（通过 reflections 数量体现）。

## 决策 4：成功的工具调用自动重置连续失败计数

```typescript
recordOutcome(toolName: string, success: boolean): void {
  if (success) {
    this.consecutiveFailures = 0;  // 成功了就清零
    this.recoveryFailureCount = 0;
  }
}
```

**为什么这样做？**
- Agent 成功完成了某一步，说明方向是对的，不需要反思
- 避免"之前失败了 2 次，后来成功了 5 步，但还被强制反思"的误触发

## 为什么不选其他方案

**方案 A：让 LLM 在 system prompt 里自己反思**
- LLM 的 self-awareness 不可靠
- 它不知道自己"失败了几次"，会编造数据
- 没有外部数据支撑的反思是空谈

**方案 B：失败就直接停止（Phase 1 的 Doom Loop）**
- 过于粗暴，很多失败是可以恢复的
- 没有引导 LLM 换策略的能力
- 用户体验差："失败了，任务结束" — 但用户想看到 Agent 尝试其他方法

**方案 C（选择）：外部检测 + 注入反思 prompt + 恢复策略提示**
- 数据驱动，精确触发
- 反思有结构，不是空话
- 反思后自动继续，不是终止

## 踩过的坑

| 问题 | 原因 | 解决 |
|------|------|------|
| 不同工具交替失败也该反思 | 只检查了同一工具 | 连续失败计数按工具名区分，但步数检查是全局的 |
| 反思后 LLM 还是重复之前的策略 | prompt 不够强 | 加入"Suggested direction"给具体建议 |
| 15 步阈值太死板 | 有些任务确实需要很多步 | 阈值可配置，Future: 按任务复杂度动态调整 |

## 关键文件

- `src/core/reflection.ts` — 反思引擎
- `src/core/agent.ts` — Agent 循环中集成反思
- `src/core/state-machine.ts` — 提供反思所需的状态快照
