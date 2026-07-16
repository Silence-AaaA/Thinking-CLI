# ADR-008: Error Taxonomy 与恢复策略设计

> Phase 3 | 状态：已实现

## 背景

Phase 2 的 Observation Layer 已经有了基础的错误分类（file_not_found / permission_error / timeout 等），但只做到了"分类"，没有做到"分类后自动恢复"。

问题：LLM 看到"文件不存在"后，经常做两件事：
1. 盲目重试同一个路径（Doom Loop）
2. 或者直接放弃，告诉用户"无法完成"

人遇到错误会根据类型选择不同策略：文件不存在就搜一搜，权限不够就换目录，网断了就等一等。Agent 也应该这样。

## 决策 1：9 种错误类型，每种对应一个恢复策略

| 错误类型 | 恢复策略 | 为什么不简单重试 |
|---------|---------|----------------|
| `tool_error` | RETRY_WITH_ALTERNATIVE | 同样的路径再试没意义，换个路径或工具 |
| `validation_error` | REGENERATE_PARAMS | 参数错了，重试同样的参数还是错 |
| `permission_error` | REQUEST_PERMISSION | 权限问题靠重试解决不了，需要人介入 |
| `timeout` | RETRY_WITH_SMALLER_SCOPE | 超时说明范围太大，缩小后再试 |
| `rate_limit` | BACKOFF_AND_RETRY | 速率限制需要等待，指数退避避免再触发 |
| `context_overflow` | COMPRESS_CONTEXT | 上下文溢出靠重试解决不了，需要压缩 |
| `network_error` | SIMPLE_RETRY | 网络问题是暂时的，等一等再试 |
| `schema_error` | REGENERATE_PARAMS | 参数格式错了，重新生成 |
| `hallucination` | CORRECT_AND_RETRY | LLM 引用了不存在的东西，纠正后重试 |

## 决策 2：恢复策略不只是"重试"，还有附加信息

每个 RecoveryPlan 包含：

```typescript
{
  action: RecoveryAction,     // 做什么
  hintForLLM: string,         // 告诉 LLM 怎么做（注入 prompt）
  countsAsRetry: boolean,     // 是否计入重试次数
  delayMs: number,            // 延迟多少毫秒
  maxRetries: number,         // 最大重试次数
}
```

**为什么需要 countsAsRetry？**

`permission_error` 不应该计入重试次数 — 权限问题不存在"重试太多次"的概念，它只是需要人帮忙。但 `tool_error` 会 — 如果换了 3 个路径都找不到文件，那可能目标本身有问题。

## 决策 3：关键词模式匹配，不做语义分析

错误分类用简单的字符串匹配：

```typescript
if (errorText.includes("timeout")) return ErrorType.TIMEOUT;
if (errorText.includes("rate limit")) return ErrorType.RATE_LIMIT;
if (errorText.includes("eacces")) return ErrorType.PERMISSION_ERROR;
```

**为什么不用 LLM 来分类错误？**
- 分类延迟：多一次 LLM 调用 = 多 1-2 秒 + 多消耗 token
- 错误文本的关键词已经足够区分（`ENOENT` / `EACCES` / `429` 是标准错误码）
- Confidence 字段表示确信度，低确信度可以降级到通用策略

## 决策 4：恢复提示自动附加到 Observation 输出

失败的工具调用，最终送给 LLM 的内容是：

```
## ❌ read_file failed: ENOENT
Key findings: ...
Error type: tool_error

**Recovery suggestion**: Try a different file path, or use grep to search for the file first.
```

**为什么不单独发一条 user message？**
- 恢复建议是和工具结果紧密相关的，放在一起上下文最清晰
- 单独发消息会打断 ReAct 循环的自然流

## 踩过的坑

| 问题 | 原因 | 解决 |
|------|------|------|
| LLM 对 `exit code 1` 完全不知道怎么办 | 错误信息太泛 | 分类后附加具体建议（"检查错误输出，换个方法"） |
| rate_limit 重试间隔太短 | 固定延迟 | 改为指数退避 `2^n × 2s`，最多等 30 秒 |
| permission_error 被算作重试 3 次后放弃 | 重试计数没有区分 | 加入 `countsAsRetry` 字段，权限问题不计入 |

## 关键文件

- `src/core/error-taxonomy.ts` — 错误分类器 + 恢复策略引擎
- `src/core/agent.ts` — Agent 循环中集成分类和恢复
