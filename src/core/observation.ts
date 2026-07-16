/**
 * Observation Layer — 观察层
 * 
 * ============================================================
 * Phase 2 核心：工具原始输出 → 结构化观察
 * 
 * 【设计原则（修正版）】
 * 1. 不是所有工具都需要精简 — read_file 的内容就是要给 LLM 看的
 * 2. 区分两类工具：
 *    - 内容工具（read_file, grep）：返回实际内容 + 摘要
 *    - 动作工具（shell, git）：只返回结构化摘要
 * 3. Observation 的 rawContent 字段携带 LLM 需要的实际数据
 * ============================================================
 */

import type { ToolCall, ToolResult } from "../tools/types.js";
import { getLogger } from "../utils/logger.js";

export interface Observation {
  /** 一句话总结 */
  summary: string;
  /** 关键数据 */
  keyFindings: string[];
  /** 是否成功 */
  success: boolean;
  /** 错误类型 */
  errorType?: string;
  /** 建议下一步 */
  suggestedAction?: string;
  /** 实际内容（read_file/grep 等工具的核心数据） */
  rawContent?: string;
  /** token 估算 */
  tokenEstimate: number;
}

export interface ObservationExtractor {
  toolNames: string[];
  extract(toolCall: ToolCall, result: ToolResult): Observation;
}

// ============================================================
// 通用提取器 — 兜底
// ============================================================

class GenericExtractor implements ObservationExtractor {
  toolNames = ["*"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (result.success) {
      const dataStr = JSON.stringify(result.data ?? {});
      const truncated = dataStr.length > 500 ? dataStr.slice(0, 500) + "..." : dataStr;
      
      return {
        summary: `${toolCall.name} completed successfully`,
        keyFindings: [truncated],
        success: true,
        rawContent: truncated,
        tokenEstimate: Math.ceil(truncated.length / 4),
      };
    } else {
      return {
        summary: `${toolCall.name} failed: ${result.error ?? "unknown error"}`,
        keyFindings: [result.error ?? "unknown error"],
        success: false,
        errorType: classifyError(result.error ?? ""),
        suggestedAction: suggestRecovery(toolCall.name, result.error ?? ""),
        tokenEstimate: 50,
      };
    }
  }
}

// ============================================================
// 文件读取提取器
// 【修正】read_file 必须返回 content，LLM 就是为了看内容才调的
// ============================================================

class FileReadExtractor implements ObservationExtractor {
  toolNames = ["read_file", "file_summary"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      return {
        summary: `Failed to read file: ${result.error}`,
        keyFindings: [result.error ?? "unknown error"],
        success: false,
        errorType: classifyError(result.error ?? ""),
        tokenEstimate: 50,
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "file_summary") {
      const funcs = (data["functions"] as string[]) ?? [];
      const classes = (data["classes"] as string[]) ?? [];
      const lines = data["lines"] as number ?? 0;
      
      return {
        summary: `${data["path"]}: ${lines} lines, ${funcs.length} functions, ${classes.length} classes`,
        keyFindings: [
          `Lines: ${lines}`,
          `Language: ${data["language"]}`,
          funcs.length > 0 ? `Functions: ${funcs.slice(0, 5).join(", ")}` : "",
          classes.length > 0 ? `Classes: ${classes.join(", ")}` : "",
        ].filter(Boolean),
        success: true,
        tokenEstimate: 60,
      };
    }

    // read_file — 返回实际文件内容
    const metadata = data["metadata"] as Record<string, unknown> | undefined;
    const content = data["content"] as string ?? "";
    
    return {
      summary: `Read ${metadata?.["showing"] ?? "file"} (${content.length} chars)`,
      keyFindings: [
        `Total lines: ${metadata?.["totalLines"] ?? "?"}`,
        `Showing: ${metadata?.["showing"] ?? "?"}`,
        metadata?.["truncated"] ? "⚠️ File truncated — may need to read more sections" : "Complete file shown",
      ],
      success: true,
      rawContent: content, // 【关键】实际文件内容
      tokenEstimate: Math.ceil(content.length / 4),
    };
  }
}

// ============================================================
// 搜索提取器
// 【修正】grep 返回的匹配内容也要带在 rawContent 里
// ============================================================

class SearchExtractor implements ObservationExtractor {
  toolNames = ["grep", "find_files"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      return {
        summary: `Search failed: ${result.error}`,
        keyFindings: [result.error ?? "unknown error"],
        success: false,
        errorType: "search_error",
        tokenEstimate: 50,
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "grep") {
      const matches = data["matches"] as Array<{ file: string; line: number; content: string }> ?? [];
      const total = data["matchesFound"] as number ?? 0;
      
      // 把匹配结果格式化为可读文本
      const matchLines = matches.map(m => `${m.file}:${m.line}: ${m.content}`);
      
      return {
        summary: `Found ${total} matches for "${data["pattern"]}"`,
        keyFindings: matches.slice(0, 5).map(m => `${m.file}:${m.line} → ${m.content.slice(0, 80)}`),
        success: true,
        rawContent: matchLines.join("\n"),
        suggestedAction: total > 5 ? `${total - 5} more matches exist. Use read_file to see specific ones.` : undefined,
        tokenEstimate: 30 + matchLines.length * 20,
      };
    }

    // find_files
    const files = data["files"] as string[] ?? [];
    return {
      summary: `Found ${files.length} files matching "${data["pattern"]}"`,
      keyFindings: files.slice(0, 10),
      success: true,
      rawContent: files.join("\n"),
      tokenEstimate: 20 + files.slice(0, 10).length * 10,
    };
  }
}

// ============================================================
// Shell 提取器 — 这个做精简是对的
// shell 输出通常很长，LLM 只需要关键信息
// ============================================================

class ShellExtractor implements ObservationExtractor {
  toolNames = ["run_shell"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    const data = result.data as Record<string, unknown> | undefined;
    const command = (data?.["command"] as string) ?? "";
    const stdout = (data?.["stdout"] as string) ?? "";
    const stderr = (data?.["stderr"] as string) ?? "";
    const exitCode = data?.["exitCode"] as number | undefined;
    const duration = data?.["duration"] as number | undefined;

    if (!result.success) {
      const errorLines = stderr.split("\n").filter(Boolean).slice(-3);
      
      return {
        summary: `Command failed (exit ${exitCode}): ${command}`,
        keyFindings: [
          `Exit code: ${exitCode}`,
          ...errorLines.map(l => `Error: ${l.trim()}`),
        ],
        success: false,
        errorType: classifyShellError(exitCode, stderr),
        suggestedAction: suggestShellRecovery(command, exitCode, stderr),
        rawContent: stderr || stdout, // 失败时带 stderr
        tokenEstimate: 80,
      };
    }

    const findings: string[] = [];
    
    if (command.startsWith("npm test") || command.includes("jest") || command.includes("vitest")) {
      findings.push(...extractTestResults(stdout));
    } else if (command.startsWith("git")) {
      findings.push(...extractGitOutput(command, stdout));
    } else {
      const lines = stdout.split("\n").filter(Boolean).slice(0, 5);
      findings.push(...lines.map(l => l.trim()));
    }

    return {
      summary: `Command succeeded (${duration}ms): ${command}`,
      keyFindings: findings.length > 0 ? findings : [stdout.slice(0, 200)],
      success: true,
      tokenEstimate: 60,
    };
  }
}

// ============================================================
// Git 提取器 — 精简
// ============================================================

class GitExtractor implements ObservationExtractor {
  toolNames = ["git_status", "git_diff", "git_log"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      return {
        summary: `Git operation failed: ${result.error}`,
        keyFindings: [result.error ?? "unknown error"],
        success: false,
        errorType: "git_error",
        tokenEstimate: 50,
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "git_status") {
      const summary = data["summary"] as Record<string, number> | undefined;
      return {
        summary: `Branch: ${data["branch"]} | ${summary?.["stagedCount"] ?? 0} staged, ${summary?.["unstagedCount"] ?? 0} unstaged, ${summary?.["untrackedCount"] ?? 0} untracked`,
        keyFindings: [
          `Branch: ${data["branch"]}`,
          `Staged: ${(data["staged"] as string[] ?? []).join(", ") || "none"}`,
          `Modified: ${(data["unstaged"] as string[] ?? []).join(", ") || "none"}`,
          `Untracked: ${(data["untracked"] as string[] ?? []).join(", ") || "none"}`,
        ],
        success: true,
        tokenEstimate: 80,
      };
    }

    if (toolCall.name === "git_diff") {
      const content = (data["content"] as string) ?? "";
      return {
        summary: `${data["type"]} diff (${data["statOnly"] ? "stat only" : "full"})`,
        keyFindings: content.split("\n").slice(0, 5),
        success: true,
        rawContent: content,
        tokenEstimate: Math.min(100, Math.ceil(content.length / 4)),
      };
    }

    const commits = data["commits"] as Array<{ hash: string; message: string }> ?? [];
    return {
      summary: `Last ${commits.length} commits`,
      keyFindings: commits.slice(0, 5).map(c => `${c.hash?.slice(0, 7)} ${c.message}`),
      success: true,
      tokenEstimate: 40,
    };
  }
}

// ============================================================
// 辅助函数
// ============================================================

function classifyError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file")) return "file_not_found";
  if (lower.includes("eacces") || lower.includes("permission")) return "permission_error";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("429") || lower.includes("rate limit")) return "rate_limit";
  if (lower.includes("syntax") || lower.includes("parse")) return "syntax_error";
  if (lower.includes("network") || lower.includes("econnreset")) return "network_error";
  return "unknown_error";
}

function classifyShellError(exitCode: number | undefined, stderr: string): string {
  if (exitCode === 124) return "timeout";
  if (exitCode === 127) return "command_not_found";
  if (exitCode === 137) return "killed_oom";
  if (stderr.toLowerCase().includes("permission denied")) return "permission_error";
  return `exit_${exitCode ?? "unknown"}`;
}

function suggestRecovery(toolName: string, error: string): string {
  const errorType = classifyError(error);
  switch (errorType) {
    case "file_not_found": return "Check the file path. Use list_dir or find_files to locate it.";
    case "permission_error": return "Permission denied. Check file permissions or try a different path.";
    case "timeout": return "Operation timed out. Try breaking it into smaller steps.";
    case "rate_limit": return "Rate limited. Wait a moment before retrying.";
    default: return "Try a different approach or ask the user for help.";
  }
}

function suggestShellRecovery(command: string, exitCode: number | undefined, stderr: string): string {
  if (exitCode === 124) return "Command timed out. Try with a longer timeout or break into smaller steps.";
  if (exitCode === 127) return "Command not found. Check if it's installed.";
  if (stderr.includes("No such file")) return "File or directory not found. Check the path.";
  return "Check the error output and try a different approach.";
}

function extractTestResults(stdout: string): string[] {
  const findings: string[] = [];
  
  const passMatch = stdout.match(/(\d+)\s+pass/i);
  const failMatch = stdout.match(/(\d+)\s+fail/i);
  const skipMatch = stdout.match(/(\d+)\s+skip/i);
  
  if (passMatch) findings.push(`Passed: ${passMatch[1]}`);
  if (failMatch) findings.push(`Failed: ${failMatch[1]}`);
  if (skipMatch) findings.push(`Skipped: ${skipMatch[1]}`);
  
  const failLine = stdout.match(/(FAIL|Error|✗|✕).*$/m);
  if (failLine) findings.push(`First failure: ${failLine[0].slice(0, 100)}`);
  
  if (findings.length === 0) {
    findings.push(...stdout.split("\n").filter(Boolean).slice(-3).map(l => l.trim()));
  }
  
  return findings;
}

function extractGitOutput(command: string, stdout: string): string[] {
  const lines = stdout.split("\n").filter(Boolean);
  return lines.slice(0, 5).map(l => l.trim());
}

// ============================================================
// Observation Manager
// ============================================================

export class ObservationManager {
  private extractors: ObservationExtractor[] = [];
  private genericExtractor = new GenericExtractor();
  private logger = getLogger();

  constructor() {
    this.register(new FileReadExtractor());
    this.register(new SearchExtractor());
    this.register(new ShellExtractor());
    this.register(new GitExtractor());
  }

  register(extractor: ObservationExtractor): void {
    this.extractors.push(extractor);
  }

  observe(toolCall: ToolCall, result: ToolResult): Observation {
    const extractor = this.extractors.find(e => 
      e.toolNames.includes(toolCall.name)
    ) ?? this.genericExtractor;

    const observation = extractor.extract(toolCall, result);

    this.logger.debug("Observation", `${toolCall.name}: ${observation.summary}`, {
      findings: observation.keyFindings.length,
      hasRawContent: !!observation.rawContent,
      tokens: observation.tokenEstimate,
    });

    return observation;
  }

  /**
   * 格式化 Observation 为 LLM 可读的字符串
   * 【修正】如果有 rawContent，必须包含在输出中
   */
  formatForLLM(observation: Observation): string {
    const parts: string[] = [];
    
    parts.push(`## ${observation.success ? "✅" : "❌"} ${observation.summary}`);
    
    if (observation.keyFindings.length > 0) {
      parts.push("");
      parts.push("Key findings:");
      for (const finding of observation.keyFindings) {
        parts.push(`- ${finding}`);
      }
    }
    
    if (observation.errorType) {
      parts.push(`\nError type: ${observation.errorType}`);
    }
    
    if (observation.suggestedAction) {
      parts.push(`\nSuggested: ${observation.suggestedAction}`);
    }
    
    // 【关键修正】如果有实际内容，附加在最后
    if (observation.rawContent) {
      parts.push(`\n---\nContent:\n${observation.rawContent}`);
    }
    
    return parts.join("\n");
  }
}
