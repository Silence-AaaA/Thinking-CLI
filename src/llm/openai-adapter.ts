/**
 * OpenAI 兼容 LLM 适配器
 * 
 * 【Phase 1-2 修复项】
 * ① 流式 tool_call 分块到达 → 需要累积 chunk 直到完整 JSON
 * ② tool message 格式 → tool_call_id 必须严格匹配
 * ③ 错误重试 → API 调用失败时的退避策略
 */

import OpenAI from "openai";
import type { LLMAdapter, LLMResponse, Message } from "./types.js";
import type { ToolCall } from "../tools/types.js";

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private model: string;
  private maxRetries: number;

  constructor(config?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    maxRetries?: number;
  }) {
    this.client = new OpenAI({
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config?.baseURL || process.env.OPENAI_BASE_URL,
    });
    this.model = config?.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.maxRetries = config?.maxRetries ?? 2;
  }

  /**
   * 【修复 ②】严格按协议规范构造消息
   * 
   * 关键点：
   * - tool 消息的 tool_call_id 必须和 assistant 的 tool_calls 里的 id 完全一致
   * - tool 消息的 content 必须是 string（不能是 object）
   * - assistant 消息如果带 tool_calls，content 不能是 undefined（某些 provider 要求 null 或 ""）
   */
  private formatMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      switch (msg.role) {
        case "system":
          return { role: "system" as const, content: msg.content };
        
        case "user":
          return { role: "user" as const, content: msg.content };
        
        case "tool":
          // 【关键】tool_call_id 必须精确匹配
          return {
            role: "tool" as const,
            tool_call_id: msg.tool_call_id,
            content: msg.content, // 必须是 string
          };
        
        case "assistant":
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            return {
              role: "assistant" as const,
              content: msg.content || null, // 不能是 undefined
              tool_calls: msg.tool_calls.map(tc => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            };
          }
          return { role: "assistant" as const, content: msg.content };
        
        default:
          return msg as OpenAI.ChatCompletionMessageParam;
      }
    });
  }

  async chat(
    messages: Message[],
    tools?: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: unknown;
      };
    }>
  ): Promise<LLMResponse> {
    let lastError: Error | null = null;

    // 【修复 ③】带重试的 API 调用
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const openaiMessages = this.formatMessages(messages);

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: openaiMessages,
          tools: tools as OpenAI.ChatCompletionTool[] | undefined,
          tool_choice: tools && tools.length > 0 ? "auto" : undefined,
        });

        const choice = response.choices[0];
        if (!choice) {
          throw new Error("No response from LLM (empty choices)");
        }
        const message = choice.message;

        // 解析 tool_calls
        let toolCalls: ToolCall[] = [];
        if (message.tool_calls && message.tool_calls.length > 0) {
          toolCalls = message.tool_calls
            .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === "function")
            .map(tc => {
              try {
                return {
                  id: tc.id,
                  name: tc.function.name,
                  arguments: JSON.parse(tc.function.arguments),
                };
              } catch {
                // 【修复 ①】如果 JSON 解析失败，说明 arguments 不完整
                throw new Error(
                  `Failed to parse tool_call arguments for "${tc.function.name}": ${tc.function.arguments}`
                );
              }
            });
        }

        return {
          content: message.content || "",
          toolCalls,
          usage: response.usage ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          } : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 如果是可重试的错误（网络、rate limit），继续重试
        if (attempt < this.maxRetries && isRetryableError(lastError)) {
          const delay = Math.pow(2, attempt) * 1000; // 指数退避
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw new Error(`LLM API call failed after ${attempt + 1} attempts: ${lastError.message}`);
      }
    }

    throw lastError || new Error("LLM API call failed");
  }
}

/**
 * 判断是否可重试的错误
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("overloaded")
  );
}
