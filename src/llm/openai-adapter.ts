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
  private temperature: number;
  /** DeepSeek 思考模式（thinking.enabled 时输出推理过程） */
  private thinking: boolean;
  /** DeepSeek 推理强度 low | medium | high */
  private reasoningEffort?: "low" | "medium" | "high";

  constructor(config?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    maxRetries?: number;
    temperature?: number;
    thinking?: boolean;
    reasoningEffort?: "low" | "medium" | "high";
  }) {
    this.client = new OpenAI({
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config?.baseURL || process.env.OPENAI_BASE_URL,
    });
    this.model = config?.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.maxRetries = config?.maxRetries ?? 2;
    this.temperature = config?.temperature ?? 0.5;

    // DeepSeek 思考模式：env DEEPSEEK_THINKING=enabled|disabled（默认关闭）
    const thinkingEnv = (process.env.DEEPSEEK_THINKING ?? "disabled").toLowerCase();
    this.thinking = config?.thinking ?? (thinkingEnv === "enabled" || thinkingEnv === "true" || thinkingEnv === "1");
    // DeepSeek 推理强度：env DEEPSEEK_REASONING_EFFORT=low|medium|high
    const effortEnv = (process.env.DEEPSEEK_REASONING_EFFORT ?? "").toLowerCase();
    this.reasoningEffort =
      config?.reasoningEffort ??
      (effortEnv === "low" || effortEnv === "medium" || effortEnv === "high" ? (effortEnv as "low" | "medium" | "high") : undefined);
  }

  /** 获取当前模型名 */
  getModel(): string {
    return this.model;
  }

  /** 动态调整温度（能力档位系统调用） */
  setTemperature(temperature: number): void {
    this.temperature = Math.max(0, Math.min(2, temperature));
  }

  /** 获取当前温度 */
  getTemperature(): number {
    return this.temperature;
  }

  /**
   * 【修复 ②】严格按协议规范构造消息
   */
  private formatMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      switch (msg.role) {
        case "system":
          return { role: "system" as const, content: msg.content };
        
        case "user":
          return { role: "user" as const, content: msg.content };
        
        case "tool":
          return {
            role: "tool" as const,
            tool_call_id: msg.tool_call_id,
            content: msg.content,
          };
        
        case "assistant":
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            return {
              role: "assistant" as const,
              content: msg.content || null,
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

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const openaiMessages = this.formatMessages(messages);

        // DeepSeek 官方格式：thinking + reasoning_effort + stream:false
        // 参考 https://api-docs.deepseek.com (base_url: https://api.deepseek.com, model: deepseek-flash)
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: openaiMessages,
          temperature: this.temperature,
          tools: tools as OpenAI.ChatCompletionTool[] | undefined,
          tool_choice: tools && tools.length > 0 ? "auto" : undefined,
          stream: false,
          // DeepSeek 专属参数（无 thinking 档位时自动省略，兼容 OpenAI）
          ...(this.thinking ? { thinking: { type: "enabled" as const } } : {}),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        } as OpenAI.ChatCompletionCreateParamsNonStreaming);

        const choice = response.choices[0];
        if (!choice) {
          throw new Error("No response from LLM (empty choices)");
        }
        const message = choice.message;

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
        
        if (attempt < this.maxRetries && isRetryableError(lastError)) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw new Error(`LLM API call failed after ${attempt + 1} attempts: ${lastError.message}`);
      }
    }

    throw lastError || new Error("LLM API call failed");
  }
}

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
