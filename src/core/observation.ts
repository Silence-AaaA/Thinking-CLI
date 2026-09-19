/**
 * Observation Layer — 观察层
 *
 * ============================================================
 * Phase 2: 工具原始输出 → 结构化观察
 * Phase 4.5 升级: Observation 输出结构化 payload + severity/confidence/suggestion
 *
 * 【升级目标】
 * 以前：Observation 偏文本摘要，LLM 只能“读句子猜意思”
 * 现在：Observation 同时提供：
 * - summary（给人/LLM 快速理解）
 * - structuredPayload（机器可读、可复用）
 * - severity / confidence / status / suggestedNextActions
 * ============================================================
 */

import type { ToolCall, ToolResult } from "../tools/types.js";
import { getLogger } from "../utils/logger.js";

export type ObservationStatus = "success" | "partial" | "blocked" | "error";
export type ObservationSeverity = "low" | "medium" | "high" | "critical";

export interface ObservationSuggestion {
  action: string;
  reason?: string;
  priority?: "low" | "medium" | "high";
}

export interface ObservationSource {
  toolName: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  filePath?: string;
}

export interface Observation {
  /** 一句话总结 */
  summary: string;
  /** 关键数据 */
  keyFindings: string[];
  /** 是否成功 */
  success: boolean;
  /** 错误类型 */
  errorType?: string;
  /** 建议下一步（旧字段，保留兼容） */
  suggestedAction?: string;
  /** 实际内容（read_file/grep 等工具的核心数据） */
  rawContent?: string;
  /** token 估算 */
  tokenEstimate: number;

  // ===== Phase 4.5 新增结构化字段 =====
  /** 观察状态 */
  status: ObservationSeverity extends never ? never : ObservationStatus;
  /** 严重程度（用于 Working Memory / Reflection 权重） */
  severity: ObservationSeverity;
  /** 置信度（0-1） */
  confidence: number;
  /** 结构化 payload（机器可读） */
  structuredPayload?: Record<string, unknown>;
  /** 结构化建议列表 */
  suggestedNextActions?: ObservationSuggestion[];
  /** 来源溯源 */
  source?: ObservationSource;
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
        status: "success",
        severity: "low",
        confidence: 0.8,
        structuredPayload: { kind: "generic_success", tool: toolCall.name },
        suggestedNextActions: [{ action: "continue", priority: "low" }],
        source: buildSource(toolCall),
      };
    }

    const errorText = result.error ?? "unknown error";
    return {
      summary: `${toolCall.name} failed: ${errorText}`,
      keyFindings: [errorText],
      success: false,
      errorType: classifyError(errorText),
      suggestedAction: suggestRecovery(errorText),
      tokenEstimate: 50,
      status: "error",
      severity: "medium",
      confidence: 0.7,
      structuredPayload: {
        kind: "generic_failure",
        tool: toolCall.name,
        errorType: classifyError(errorText),
      },
      suggestedNextActions: [{ action: "analyze_failure", reason: "tool failed", priority: "medium" }],
      source: buildSource(toolCall),
    };
  }
}

// ============================================================
// 文件读取提取器
// ============================================================

class FileReadExtractor implements ObservationExtractor {
  toolNames = ["read_file", "file_summary"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      const errorText = result.error ?? "unknown error";
      return {
        summary: `Failed to read file: ${errorText}`,
        keyFindings: [errorText],
        success: false,
        errorType: classifyError(errorText),
        tokenEstimate: 50,
        status: "error",
        severity: "medium",
        confidence: 0.82,
        structuredPayload: {
          kind: "file_read_failure",
          path: toolCall.arguments?.path,
          errorType: classifyError(errorText),
        },
        suggestedNextActions: [
          { action: "verify_path", reason: "file read failed", priority: "medium" },
          { action: "list_nearby_files", priority: "low" },
        ],
        source: buildSource(toolCall),
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "file_summary") {
      const funcs = (data["functions"] as string[]) ?? [];
      const classes = (data["classes"] as string[]) ?? [];
      const lines = (data["lines"] as number) ?? 0;

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
        status: "success",
        severity: "low",
        confidence: 0.88,
        structuredPayload: {
          kind: "file_summary",
          path: data["path"],
          language: data["language"],
          lines,
          functionCount: funcs.length,
          classCount: classes.length,
        },
        suggestedNextActions: [{ action: "inspect_suspicious_functions", priority: "low" }],
        source: buildSource(toolCall, toolCall.arguments?.path as string),
      };
    }

    const metadata = data["metadata"] as Record<string, unknown> | undefined;
    const content = (data["content"] as string) ?? "";

    return {
      summary: `Read ${metadata?.["showing"] ?? "file"} (${content.length} chars)`,
      keyFindings: [
        `Total lines: ${metadata?.["totalLines"] ?? "?"}`,
        `Showing: ${metadata?.["showing"] ?? "?"}`,
        metadata?.["truncated"] ? "⚠️ File truncated — may need to read more sections" : "Complete file shown",
      ],
      success: true,
      rawContent: content,
      tokenEstimate: Math.ceil(content.length / 4),
      status: metadata?.["truncated"] ? "partial" : "success",
      severity: metadata?.["truncated"] ? "medium" : "low",
      confidence: 0.86,
      structuredPayload: {
        kind: "file_read",
        path: toolCall.arguments?.path,
        totalLines: metadata?.["totalLines"],
        showing: metadata?.["showing"],
        truncated: !!metadata?.["truncated"],
        contentLength: content.length,
      },
      suggestedNextActions: metadata?.["truncated"]
        ? [{ action: "read_missing_sections", reason: "file truncated", priority: "high" }]
        : [{ action: "continue", priority: "low" }],
      source: buildSource(toolCall, toolCall.arguments?.path as string),
    };
  }
}

// ============================================================
// 搜索提取器
// ============================================================

class SearchExtractor implements ObservationExtractor {
  toolNames = ["grep", "find_files"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      const errorText = result.error ?? "unknown error";
      return {
        summary: `Search failed: ${errorText}`,
        keyFindings: [errorText],
        success: false,
        errorType: classifyError(errorText),
        tokenEstimate: 50,
        status: "error",
        severity: "medium",
        confidence: 0.75,
        structuredPayload: {
          kind: "search_failure",
          tool: toolCall.name,
          query: toolCall.arguments?.query ?? toolCall.arguments?.pattern,
          errorType: classifyError(errorText),
        },
        suggestedNextActions: [{ action: "adjust_query", priority: "medium" }],
        source: buildSource(toolCall),
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "grep") {
      const matches = (data["matches"] as Array<{ file: string; line: number; content: string }>) ?? [];
      const total = (data["totalMatches"] as number) ?? matches.length;

      return {
        summary: `Found ${total} matches for "${toolCall.arguments?.pattern ?? toolCall.arguments?.query}"`,
        keyFindings: matches.slice(0, 5).map((m) => `${m.file}:${m.line} → ${m.content.trim().slice(0, 80)}`),
        success: true,
        tokenEstimate: 80,
        status: "success",
        severity: total > 0 ? "medium" : "low",
        confidence: 0.88,
        structuredPayload: {
          kind: "grep_result",
          pattern: toolCall.arguments?.pattern ?? toolCall.arguments?.query,
          totalMatches: total,
          topMatches: matches.slice(0, 5).map((m) => ({
            file: m.file,
            line: m.line,
            preview: m.content.trim().slice(0, 120),
          })),
        },
        suggestedNextActions:
          total > 5
            ? [{ action: "inspect_top_matches", reason: "many matches", priority: "high" }]
            : [{ action: "continue", priority: "low" }],
        source: buildSource(toolCall),
      };
    }

    // find_files
    const files = (data["files"] as string[]) ?? [];
    return {
      summary: `Found ${files.length} files`,
      keyFindings: files.slice(0, 5),
      success: true,
      tokenEstimate: 60,
      status: "success",
      severity: files.length === 0 ? "medium" : "low",
      confidence: 0.84,
      structuredPayload: {
        kind: "find_files_result",
        totalFiles: files.length,
        topFiles: files.slice(0, 10),
      },
      suggestedNextActions:
        files.length === 0
          ? [{ action: "broaden_search", reason: "no files found", priority: "high" }]
          : [{ action: "inspect_candidate_files", priority: "medium" }],
      source: buildSource(toolCall),
    };
  }
}

// ============================================================
// Shell 提取器
// ============================================================

class ShellExtractor implements ObservationExtractor {
  toolNames = ["run_shell"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    const data = (result.data ?? {}) as Record<string, unknown>;
    const stdout = ((data["stdout"] as string) ?? "").trim();
    const stderr = ((data["stderr"] as string) ?? "").trim();
    const exitCode = data["exitCode"] as number | undefined;
    const durationMs = data["durationMs"] as number | undefined;
    const command = (toolCall.arguments?.command as string) ?? "";

    if (!result.success) {
      const errorType = classifyShellError(exitCode, stderr);
      return {
        summary: `Command failed (exit ${exitCode ?? "?"}): ${command.slice(0, 80)}`,
        keyFindings: [
          `Exit code: ${exitCode ?? "?"}`,
          stderr ? `Error: ${stderr.split("\n").slice(-2).join(" | ").slice(0, 120)}` : "",
          `Duration: ${durationMs ?? "?"}ms`,
        ].filter(Boolean),
        success: false,
        errorType,
        suggestedAction: suggestShellRecovery(exitCode, stderr),
        tokenEstimate: 70,
        status: "error",
        severity: inferShellSeverity(exitCode, stderr),
        confidence: 0.82,
        structuredPayload: {
          kind: "shell_failure",
          command,
          exitCode,
          durationMs,
          isTimeout: exitCode === 124,
          isPermissionDenied: stderr.toLowerCase().includes("permission denied"),
          isCommandNotFound: exitCode === 127,
          lastStderrLines: stderr.split("\n").filter(Boolean).slice(-3),
        },
        suggestedNextActions: [
          { action: "reduce_scope", reason: "shell failure", priority: "high" },
          { action: "retry_with_different_command", priority: "medium" },
        ],
        source: buildSource(toolCall),
      };
    }

    const testResults = extractTestResults(stdout);
    const isTestCommand = /npm\s+run\s+test|vitest|jest|tsx\s+src\/test/i.test(command);

    return {
      summary: `Command succeeded (${durationMs ?? "?"}ms): ${command.slice(0, 80)}`,
      keyFindings: isTestCommand
        ? testResults
        : stdout
            .split("\n")
            .filter(Boolean)
            .slice(-3)
            .map((l) => l.trim()),
      success: true,
      tokenEstimate: 60,
      status: "success",
      severity: "low",
      confidence: 0.86,
      structuredPayload: {
        kind: isTestCommand ? "test_result" : "shell_success",
        command,
        exitCode,
        durationMs,
        passed: extractCount(stdout, /(\d+)\s+pass/i),
        failed: extractCount(stdout, /(\d+)\s+fail/i),
        skipped: extractCount(stdout, /(\d+)\s+skip/i),
      },
      suggestedNextActions: [{ action: "continue", priority: "low" }],
      source: buildSource(toolCall),
    };
  }
}

// ============================================================
// Git 提取器
// ============================================================

class GitExtractor implements ObservationExtractor {
  toolNames = ["git_status", "git_diff", "git_log"];

  extract(toolCall: ToolCall, result: ToolResult): Observation {
    if (!result.success) {
      const errorText = result.error ?? "unknown error";
      return {
        summary: `Git command failed: ${errorText}`,
        keyFindings: [errorText],
        success: false,
        errorType: classifyError(errorText),
        tokenEstimate: 50,
        status: "error",
        severity: "medium",
        confidence: 0.78,
        structuredPayload: {
          kind: "git_failure",
          command: toolCall.name,
          errorType: classifyError(errorText),
        },
        suggestedNextActions: [{ action: "retry_or_switch_git_command", priority: "medium" }],
        source: buildSource(toolCall),
      };
    }

    const data = result.data as Record<string, unknown>;

    if (toolCall.name === "git_status") {
      const branch = data["branch"] ?? "unknown";
      const staged = (data["staged"] as string[]) ?? [];
      const modified = (data["modified"] as string[]) ?? [];
      const untracked = (data["untracked"] as string[]) ?? [];

      return {
        summary: `Branch: ${branch} | ${staged.length} staged, ${modified.length} unstaged, ${untracked.length} untracked`,
        keyFindings: [
          `Branch: ${branch}`,
          staged.length > 0 ? `Staged: ${staged.join(", ")}` : "",
          modified.length > 0 ? `Modified: ${modified.slice(0, 3).join(", ")}` : "",
          untracked.length > 0 ? `Untracked: ${untracked.slice(0, 3).join(", ")}` : "",
        ].filter(Boolean),
        success: true,
        tokenEstimate: 60,
        status: "success",
        severity: modified.length + staged.length + untracked.length > 5 ? "medium" : "low",
        confidence: 0.9,
        structuredPayload: {
          kind: "git_status",
          branch,
          stagedCount: staged.length,
          modifiedCount: modified.length,
          untrackedCount: untracked.length,
          stagedFiles: staged.slice(0, 10),
          modifiedFiles: modified.slice(0, 10),
          untrackedFiles: untracked.slice(0, 10),
        },
        suggestedNextActions:
          modified.length + staged.length > 0
            ? [{ action: "inspect_key_changed_files", priority: "high" }]
            : [{ action: "continue", priority: "low" }],
        source: buildSource(toolCall),
      };
    }

    const lines = ((data["content"] as string) ?? "").split("\n").filter(Boolean);
    return {
      summary: `${toolCall.name}: ${lines.length} lines`,
      keyFindings: lines.slice(0, 5).map((l) => l.trim()),
      success: true,
      tokenEstimate: 60,
      status: "success",
      severity: "low",
      confidence: 0.82,
      structuredPayload: {
        kind: toolCall.name,
        lineCount: lines.length,
        previewLines: lines.slice(0, 8).map((l) => l.trim()),
      },
      suggestedNextActions: [{ action: "continue", priority: "low" }],
      source: buildSource(toolCall),
    };
  }
}

// ============================================================
// 工具函数
// ============================================================

function buildSource(toolCall: ToolCall, filePath?: string): ObservationSource {
  return {
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    arguments: toolCall.arguments,
    filePath: filePath ?? (toolCall.arguments?.path as string | undefined),
  };
}

function classifyError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file"))
    return "file_not_found";
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

function inferShellSeverity(exitCode: number | undefined, stderr: string): ObservationSeverity {
  if (exitCode === 124) return "high";
  if (exitCode === 137) return "high";
  if (stderr.toLowerCase().includes("permission denied")) return "high";
  return "medium";
}

function suggestRecovery(error: string): string {
  const errorType = classifyError(error);
  switch (errorType) {
    case "file_not_found":
      return "Check the file path. Use list_dir or find_files to locate it.";
    case "permission_error":
      return "Permission denied. Check file permissions or try a different path.";
    case "timeout":
      return "Operation timed out. Try breaking it into smaller steps.";
    case "rate_limit":
      return "Rate limited. Wait a moment before retrying.";
    default:
      return "Try a different approach or ask the user for help.";
  }
}

function suggestShellRecovery(exitCode: number | undefined, stderr: string): string {
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
    findings.push(
      ...stdout
        .split("\n")
        .filter(Boolean)
        .slice(-3)
        .map((l) => l.trim()),
    );
  }

  return findings;
}

function extractCount(text: string, pattern: RegExp): number | undefined {
  const m = text.match(pattern);
  return m ? Number(m[1]) : undefined;
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
    const extractor = this.extractors.find((e) => e.toolNames.includes(toolCall.name)) ?? this.genericExtractor;

    const observation = extractor.extract(toolCall, result);

    this.logger.debug("Observation", `${toolCall.name}: ${observation.summary}`, {
      status: observation.status,
      severity: observation.severity,
      confidence: observation.confidence,
      findings: observation.keyFindings.length,
      hasRawContent: !!observation.rawContent,
      tokens: observation.tokenEstimate,
    });

    return observation;
  }

  /**
   * 格式化 Observation 为 LLM 可读的字符串
   */
  formatForLLM(observation: Observation): string {
    const parts: string[] = [];

    parts.push(`## ${observation.success ? "✅" : "❌"} ${observation.summary}`);
    parts.push("");
    parts.push(`Status: ${observation.status}`);
    parts.push(`Severity: ${observation.severity}`);
    parts.push(`Confidence: ${observation.confidence}`);

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

    if (observation.suggestedNextActions && observation.suggestedNextActions.length > 0) {
      parts.push("");
      parts.push("Suggested next actions:");
      for (const suggestion of observation.suggestedNextActions) {
        parts.push(
          `- [${suggestion.priority ?? "medium"}] ${suggestion.action}${suggestion.reason ? ` — ${suggestion.reason}` : ""}`,
        );
      }
    } else if (observation.suggestedAction) {
      parts.push(`\nSuggested: ${observation.suggestedAction}`);
    }

    if (observation.rawContent) {
      parts.push(`\n---\nContent:\n${observation.rawContent}`);
    }

    return parts.join("\n");
  }
}
