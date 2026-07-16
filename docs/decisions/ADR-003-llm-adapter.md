# ADR-003: LLM 适配层抽象与重试策略

> Phase 1 | 状态：已实现

## 背景

不同 LLM 提供商（OpenAI、DeepSeek、Moonshot、本地 Ollama）的 API 格式略有不同。
如果直接在 Agent 里调 OpenAI SDK，换模型就要改 Agent 代码。

## 决策 1：统一接口抽象

定义 `LLMAdapter` 接口，Agent 只依赖接口，不依赖具体实现：

```typescript
interface LLMAdapter {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}
```

当前只有一个实现 `OpenAIAdapter`，但因为大多数提供商都兼容 OpenAI API，
所以一个适配器就能覆盖大多数场景。

## 决策 2：消息格式转换

我们的 `Message` 类型和 OpenAI 的 `ChatCompletionMessageParam` 不完全一致。
在 `formatMessages()` 里做转换，关键点：

| 我们的格式 | OpenAI 格式 | 注意事项 |
|-----------|------------|---------|
| assistant.tool_calls | 需要 JSON.stringify(arguments) | arguments 必须是字符串 |
| tool 消息 | tool_call_id 必须精确匹配 | 否则 400 错误 |
| assistant.content | 不能是 undefined | 某些 provider 要求 null |

## 决策 3：重试策略

API 调用可能因网络、rate limit、服务过载等原因失败。

| 错误类型 | 是否重试 | 策略 |
|----------|---------|------|
| Rate limit (429) | ✅ | 指数退避 |
| 网络错误 (ECONNRESET) | ✅ | 指数退避 |
| 服务过载 (503) | ✅ | 指数退避 |
| 参数错误 (400) | ❌ | 直接报错 |
| 认证错误 (401) | ❌ | 直接报错 |

指数退避：第 1 次等 1 秒，第 2 次等 2 秒，第 3 次报错。

## 踩过的坑

**问题**：tool_call 的 arguments JSON 解析失败。
原因：流式返回时 arguments 被拆成多个 chunk，如果只拿到一半就会解析失败。
解决：捕获 JSON.parse 错误，给出明确的错误信息，不静默忽略。

## 关键文件

- `src/llm/types.ts` — LLMAdapter 接口定义
- `src/llm/openai-adapter.ts` — OpenAI 兼容实现 + 重试
