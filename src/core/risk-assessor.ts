/**
 * 分级审批系统 - 操作风险评估
 *
 * Phase 2 | 已实现
 *
 * 【v2 修正】
 * - 新增：检测通过脚本语言绕过安全机制的行为
 * - 例：python -c "os.remove('file')" 和 rm 等价，应该同样需要确认
 */

import type { ToolCall } from "../tools/types.js";

export enum RiskLevel {
  READ = "READ",
  WRITE = "WRITE",
  EXECUTE = "EXECUTE",
  DESTRUCTIVE = "DESTRUCTIVE",
  BLOCKED = "BLOCKED",
}

export enum ApprovalDecision {
  ALLOW = "ALLOW",
  CONFIRM = "CONFIRM",
  DENY = "DENY",
}

export interface RiskAssessment {
  level: RiskLevel;
  decision: ApprovalDecision;
  reason: string;
  risks: string[];
}

export class RiskAssessor {
  assess(toolCall: ToolCall): RiskAssessment {
    const { name, arguments: args } = toolCall;

    switch (name) {
      case "read_file":
      case "file_summary":
      case "list_dir":
        return this.assessRead(name, args);
      case "write_file":
        return this.assessWrite(args);
      case "grep":
      case "find_files":
        return this.assessSearch(args);
      case "run_shell":
        return this.assessShell(args);
      case "git_status":
      case "git_diff":
      case "git_log":
        return this.assessGitRead(name);
      default:
        return this.assessUnknown(name);
    }
  }

  private assessRead(toolName: string, args: Record<string, unknown>): RiskAssessment {
    const path = (args["path"] as string) || "";
    const sensitivePatterns = [/\.env$/i, /id_rsa/i, /\.pem$/i, /credentials/i, /secret/i, /password/i];
    const risks: string[] = [];
    for (const pattern of sensitivePatterns) {
      if (pattern.test(path)) risks.push(`Reading potentially sensitive file: ${path}`);
    }
    return {
      level: RiskLevel.READ,
      decision: ApprovalDecision.ALLOW,
      reason: `Safe read: ${toolName}`,
      risks,
    };
  }

  private assessWrite(args: Record<string, unknown>): RiskAssessment {
    const path = (args["path"] as string) || "";
    const risks: string[] = [];
    const criticalPatterns = [
      { pattern: /package\.json$/i, reason: "Modifying package.json" },
      { pattern: /tsconfig/i, reason: "Modifying TypeScript config" },
      { pattern: /\.env$/i, reason: "Modifying environment variables" },
    ];
    for (const { pattern, reason } of criticalPatterns) {
      if (pattern.test(path)) risks.push(reason);
    }
    return {
      level: RiskLevel.WRITE,
      decision: ApprovalDecision.ALLOW,
      reason: `Write: ${path}`,
      risks,
    };
  }

  private assessSearch(_args: Record<string, unknown>): RiskAssessment {
    return {
      level: RiskLevel.READ,
      decision: ApprovalDecision.ALLOW,
      reason: "Search operation",
      risks: [],
    };
  }

  /**
   * Shell 命令评估
   *
   * 【v2 新增】检测通过脚本语言绕过安全机制的行为
   * 例如：python -c "os.remove('file')" 等价于 rm，应该同样处理
   */
  private assessShell(args: Record<string, unknown>): RiskAssessment {
    const command = (args["command"] as string) || "";
    const risks: string[] = [];

    // === 直接拒绝 ===
    const blockedPatterns = [
      { pattern: /rm\s+-rf\s+[/\\]/i, reason: "Recursive delete from root" },
      { pattern: />\s*\/dev\//i, reason: "Writing to device files" },
      { pattern: /mkfs/i, reason: "Format filesystem" },
      { pattern: /dd\s+.*of=/i, reason: "Direct disk write" },
      { pattern: /chmod\s+777/i, reason: "Overly permissive permissions" },
      { pattern: /curl.*\|\s*(ba)?sh/i, reason: "Piping remote content to shell" },
      { pattern: /wget.*\|\s*(ba)?sh/i, reason: "Piping remote content to shell" },
    ];
    for (const { pattern, reason } of blockedPatterns) {
      if (pattern.test(command)) {
        return {
          level: RiskLevel.BLOCKED,
          decision: ApprovalDecision.DENY,
          reason: `Blocked: ${reason}`,
          risks: [reason],
        };
      }
    }

    // === 检测脚本语言绕过（v2 新增）===
    const bypassCheck = this.detectScriptBypass(command);
    if (bypassCheck) {
      risks.push(...bypassCheck.risks);
      return {
        level: RiskLevel.DESTRUCTIVE,
        decision: ApprovalDecision.CONFIRM,
        reason: bypassCheck.reason,
        risks,
      };
    }

    // === 危险命令（需要确认）===
    let level = RiskLevel.EXECUTE;
    const destructivePatterns = [
      { pattern: /\brm\b/i, reason: "Deleting files" },
      { pattern: /\bdel\b/i, reason: "Deleting files (Windows)" },
      { pattern: /\brmdir\b/i, reason: "Removing directories" },
      { pattern: /git\s+push\s+.*--force/i, reason: "Force push" },
      { pattern: /git\s+reset\s+--hard/i, reason: "Hard reset" },
      { pattern: /git\s+clean\s+-fd/i, reason: "Clean untracked files" },
      { pattern: /npm\s+publish/i, reason: "Publishing package" },
      { pattern: /npm\s+uninstall/i, reason: "Uninstalling packages" },
    ];
    for (const { pattern, reason } of destructivePatterns) {
      if (pattern.test(command)) {
        risks.push(reason);
        level = RiskLevel.DESTRUCTIVE;
      }
    }

    const decision = level === RiskLevel.DESTRUCTIVE ? ApprovalDecision.CONFIRM : ApprovalDecision.ALLOW;
    return { level, decision, reason: `Shell: ${command}`, risks };
  }

  /**
   * 【v2 新增】检测通过脚本语言绕过安全机制的行为
   *
   * LLM 很聪明——如果 rm 被拦了，它会用 python/node 来做同样的事。
   * 我们需要检测这种"等价危险操作"。
   */
  private detectScriptBypass(command: string): { reason: string; risks: string[] } | null {
    // 检测文件删除
    const deletePatterns = [
      { pattern: /os\.remove/i, reason: "Python file deletion (equivalent to rm)" },
      { pattern: /os\.unlink/i, reason: "Python file deletion (equivalent to rm)" },
      { pattern: /shutil\.rmtree/i, reason: "Python recursive deletion (equivalent to rm -rf)" },
      { pattern: /fs[\W_]*\.unlinkSync/i, reason: "Node.js file deletion (equivalent to rm)" },
      { pattern: /fs[\W_]*\.rmSync/i, reason: "Node.js file deletion (equivalent to rm)" },
      { pattern: /fs['"]?\.rm\b/i, reason: "Node.js file deletion (equivalent to rm)" },
      { pattern: /rimraf/i, reason: "Recursive deletion (equivalent to rm -rf)" },
      { pattern: /del\s+\/[sfq]/i, reason: "Windows forced deletion" },
    ];

    for (const { pattern, reason } of deletePatterns) {
      if (pattern.test(command)) {
        return { reason, risks: [reason, "Detected script-based bypass of deletion safety check"] };
      }
    }

    // 检测文件覆写
    const overwritePatterns = [
      { pattern: /fs\.writeFileSync/i, reason: "Node.js file write" },
      { pattern: /open\(.*['"]w['"]/, reason: "Python file overwrite" },
    ];

    for (const { pattern, reason } of overwritePatterns) {
      if (pattern.test(command)) {
        return { reason, risks: [reason] };
      }
    }

    // 检测命令执行
    const execPatterns = [
      { pattern: /subprocess\.call/i, reason: "Python subprocess execution" },
      { pattern: /child_process/i, reason: "Node.js child process execution" },
      { pattern: /execSync/i, reason: "Node.js synchronous execution" },
    ];

    for (const { pattern, reason } of execPatterns) {
      if (pattern.test(command)) {
        return { reason, risks: [reason] };
      }
    }

    return null;
  }

  private assessGitRead(toolName: string): RiskAssessment {
    return {
      level: RiskLevel.READ,
      decision: ApprovalDecision.ALLOW,
      reason: `Git read: ${toolName}`,
      risks: [],
    };
  }

  private assessUnknown(toolName: string): RiskAssessment {
    return {
      level: RiskLevel.EXECUTE,
      decision: ApprovalDecision.ALLOW,
      reason: `Unknown tool: ${toolName}`,
      risks: ["Unknown tool"],
    };
  }
}
