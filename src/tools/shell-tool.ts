import { exec } from "child_process";
import type { Tool, ToolResult } from "./types.js";

/**
 * 白名单命令 — 这些命令允许执行，但可能仍有风险（由审批网关控制）
 */
const ALLOWED_COMMANDS = new Set([
  "ls",
  "dir",
  "cat",
  "type",
  "echo",
  "pwd",
  "git",
  "npm",
  "node",
  "python",
  "python3",
  "tsc",
  "npx",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "diff",
  "rm",
  "del",
  "rmdir", // 【修复】加入删除命令，风险由审批网关控制
]);

/**
 * 直接拒绝的模式 — 不管审批结果如何都不执行
 * 这些是"绝对危险"，即使用户确认也不该执行
 */
const ABSOLUTE_BLOCK_PATTERNS = [
  /rm\s+-rf\s+[/\\]/i, // 递归删除根目录
  /mkfs/i, // 格式化
  />\s*\/dev\//i, // 写设备
  /dd\s+.*of=/i, // 直接磁盘写入
  /chmod\s+777/i, // 过宽权限
];

/**
 * 需要审批网关确认的模式
 * 这些命令在白名单里，但执行前必须经过 RiskAssessor
 */
const NEEDS_APPROVAL_PATTERNS = [
  /\brm\b/i,
  /\bdel\b/i,
  /\brmdir\b/i,
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean/i,
];

function validateCommand(cmd: string): { valid: boolean; needsApproval: boolean; error?: string } {
  // 绝对拒绝
  for (const pattern of ABSOLUTE_BLOCK_PATTERNS) {
    if (pattern.test(cmd)) {
      return { valid: false, needsApproval: false, error: `Blocked: ${pattern}` };
    }
  }

  // 提取基础命令
  const firstCmd = cmd.split("|")[0]?.trim().split(/\s+/)[0] ?? "";

  if (!ALLOWED_COMMANDS.has(firstCmd)) {
    return {
      valid: false,
      needsApproval: false,
      error: `Command "${firstCmd}" is not in the allowed list. Allowed: ${Array.from(ALLOWED_COMMANDS).join(", ")}`,
    };
  }

  // 检查是否需要审批
  let needsApproval = false;
  for (const pattern of NEEDS_APPROVAL_PATTERNS) {
    if (pattern.test(cmd)) {
      needsApproval = true;
      break;
    }
  }

  return { valid: true, needsApproval };
}

export const shellTool: Tool = {
  name: "run_shell",
  description: `Execute a shell command.
SAFETY: Dangerous commands require user approval.
Destructive patterns (rm -rf /, mkfs, etc.) are always blocked.
Output is truncated to save tokens.`,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds. Default: 30000 (30 seconds)",
      },
      maxOutputLength: {
        type: "number",
        description: "Max output characters to return. Default: 2000",
      },
    },
    required: ["command"],
  },
  execute: async (params): Promise<ToolResult> => {
    const command = params["command"] as string;
    const timeout = (params["timeout"] as number) || 30000;
    const maxOutputLength = (params["maxOutputLength"] as number) || 2000;

    const validation = validateCommand(command);
    if (!validation.valid) {
      return {
        success: false,
        error: `Security check failed: ${validation.error}`,
      };
    }

    // 注意：needsApproval 的判断由 ApprovalGateway 在调用本工具之前完成
    // 这里只做最终的白名单校验

    return new Promise((resolve) => {
      const startTime = Date.now();

      exec(
        command,
        {
          timeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
        },
        (error, stdout, stderr) => {
          const duration = Date.now() - startTime;

          const truncatedStdout =
            stdout.length > maxOutputLength ? stdout.slice(0, maxOutputLength) + "\n... (truncated)" : stdout;

          const truncatedStderr =
            (stderr ?? "").length > maxOutputLength / 2
              ? (stderr ?? "").slice(0, maxOutputLength / 2) + "\n... (truncated)"
              : (stderr ?? "");

          if (error) {
            resolve({
              success: false,
              data: {
                command,
                exitCode: error.code,
                stdout: truncatedStdout,
                stderr: truncatedStderr,
                duration,
              },
              error: `Command failed with exit code ${error.code}`,
              tokenEstimate: Math.ceil((truncatedStdout.length + truncatedStderr.length) / 4),
            });
          } else {
            resolve({
              success: true,
              data: {
                command,
                exitCode: 0,
                stdout: truncatedStdout,
                stderr: truncatedStderr || undefined,
                duration,
                truncated: stdout.length > maxOutputLength,
              },
              tokenEstimate: Math.ceil(truncatedStdout.length / 4),
            });
          }
        },
      );
    });
  },
};

export const shellTools = [shellTool];
