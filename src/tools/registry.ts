import type { Tool, ToolResult, ToolCall } from "./types.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getToolDefinitions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Tool["parameters"];
    };
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: "${toolCall.name}". Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
      };
    }

    try {
      const params = toolCall.arguments;
      const required = tool.parameters.required || [];
      for (const key of required) {
        if (!(key in params)) {
          return {
            success: false,
            error: `Missing required parameter: "${key}"`,
          };
        }
      }

      const result = await tool.execute(params);
      return result;
    } catch (error) {
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  listTools(): string[] {
    return Array.from(this.tools.keys());
  }
}
