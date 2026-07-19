# ADR-013: Observation 结构化载荷设计

> Phase 4.5 | 状态：已实现

## 背景

原有 Observation 输出偏“文本摘要”，LLM 只能“读句子”来理解工具结果。  
这导致：
1. Working Memory 难以自动判断“哪条信息更重要”
2. Reflection 难以做高质量决策
3. Recovery 往往只能按宽泛错误类型行动

## 决策

Observation 从“summary + findings”升级为“结构化决策载荷”：

- `status`: success / partial / blocked / error
- `severity`: low / medium / high / critical
- `confidence`: 0-1
- `structuredPayload`: 机器可读 JSON（如 test passed/failed/duration）
- `suggestedNextActions[]`: 结构化建议列表
- `source`: 来源工具、toolCallId、filePath

## 为什么不继续只用纯文本

- 文本适合人类阅读，但不适合自动策略引擎
- 结构化字段可以直接驱动 WM 权重、Reflection 触发、Recovery 选择

## 关键收益

- Working Memory 可根据 severity/confidence 自动升权/降权
- Reflection 可基于 payload 决策，不再靠关键词猜
- CLI 和日志可直接观察“观察质量”

## 关键文件

- `src/core/observation.ts`
