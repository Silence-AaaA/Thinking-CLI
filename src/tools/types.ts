/**
 * 工具系统的核心类型定义
 * 
 * 【学习要点】
 * Agent 的能力来自于它的"工具"。每个工具都有：
 * 1. 名称和描述（告诉 LLM 这个工具能做什么）
 * 2. 参数 schema（告诉 LLM 怎么调用这个工具）
 * 3. 执行函数（实际干活的代码）
 * 
 * 这个设计和 OpenAI 的 function calling 协议完全对齐，
 * 这样你可以直接把工具定义发给 LLM，让它决定调哪个。
 */

/**
 * 工具参数的 JSON Schema 定义
 * 这就是告诉 LLM "这个工具接受什么参数"的方式
 */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

/**
 * 工具执行结果
 * 
 * 【设计决策】为什么要有 success 字段？
 * 因为 LLM 需要知道工具是否执行成功，以便决定下一步。
 * 如果失败了，error 信息会告诉 LLM 为什么失败，让它能自我修正。
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** 
   * token 消耗估算（可选）
   * 【学习要点】记录每个工具消耗多少 token，帮助你优化
   */
  tokenEstimate?: number;
}

/**
 * 工具定义接口
 * 
 * 【学习要点】
 * 每个工具都是一个"自描述"的实体：
 * - name: 工具名，LLM 通过这个名字来调用它
 * - description: 告诉 LLM 这个工具能做什么、什么时候该用它
 * - parameters: JSON Schema，告诉 LLM 怎么传参
 * - execute: 实际执行的函数
 * 
 * description 非常重要！写得好，LLM 就能正确选择工具；
 * 写得差，LLM 就会乱用或不用。
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * LLM 的 tool_call 输出格式
 * 
 * 【学习要点】
 * 当 LLM 决定使用工具时，它会返回这个格式的 JSON。
 * 这是 OpenAI function calling 的标准格式。
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
