import type { ToolCall } from "../tools/types.js";

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMAdapter {
  chat(
    messages: Message[],
    tools?: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: unknown;
      };
    }>,
  ): Promise<LLMResponse>;

  /** 可选：获取当前模型名 */
  getModel?(): string;

  /** 可选：动态调整温度（用于能力档位系统） */
  setTemperature?(temperature: number): void;
}
