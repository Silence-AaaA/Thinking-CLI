/**
 * Error Taxonomy & Recovery Strategies — 错误分类与恢复
 *
 * ============================================================
 * Phase 3 核心：把错误归类，每种错误对应一个恢复策略
 *
 * 【设计哲学】
 * 不同的错误需要不同的恢复方式。
 * 比如"文件不存在"可以换路径重试，
 * "权限不足"需要申请审批，
 * "速率限制"需要等待后重试。
 *
 * 9 种错误类型 + 对应恢复策略：
 *   tool_error       → 换路径/换工具
 *   validation_error → 重新生成参数
 *   permission_error → 申请审批或跳过
 *   timeout          → 缩小范围重试
 *   rate_limit       → 指数退避
 *   context_overflow → 压缩上下文
 *   network_error    → 重试（有限次）
 *   schema_error     → 重新生成
 *   hallucination    → Observation 层校验后纠正
 * ============================================================
 */

import type { ToolCall, ToolResult } from "../tools/types.js";
import { getLogger } from "../utils/logger.js";

/** 9 种错误类型 */
export enum ErrorType {
  TOOL_ERROR = "tool_error",
  VALIDATION_ERROR = "validation_error",
  PERMISSION_ERROR = "permission_error",
  TIMEOUT = "timeout",
  RATE_LIMIT = "rate_limit",
  CONTEXT_OVERFLOW = "context_overflow",
  NETWORK_ERROR = "network_error",
  SCHEMA_ERROR = "schema_error",
  HALLUCINATION = "hallucination",
}

/** 恢复策略 */
export enum RecoveryAction {
  /** 换路径或换工具重试 */
  RETRY_WITH_ALTERNATIVE = "retry_with_alternative",
  /** 重新生成工具参数 */
  REGENERATE_PARAMS = "regenerate_params",
  /** 请求用户授权 */
  REQUEST_PERMISSION = "request_permission",
  /** 缩小范围后重试（比如限制行数） */
  RETRY_WITH_SMALLER_SCOPE = "retry_with_smaller_scope",
  /** 等待后指数退避重试 */
  BACKOFF_AND_RETRY = "backoff_and_retry",
  /** 压缩上下文后重试 */
  COMPRESS_CONTEXT = "compress_context",
  /** 简单重试 */
  SIMPLE_RETRY = "simple_retry",
  /** 修正后重试（针对 schema 或幻觉） */
  CORRECT_AND_RETRY = "correct_and_retry",
  /** 跳过，告知 LLM 换方案 */
  SKIP_AND_REPLAN = "skip_and_replan",
  /** 无法恢复，终止 */
  ABORT = "abort",
}

/** 恢复策略详情 */
export interface RecoveryPlan {
  action: RecoveryAction;
  /** 给 LLM 的提示信息 */
  hintForLLM: string;
  /** 是否应该计入重试次数 */
  countsAsRetry: boolean;
  /** 延迟（毫秒），用于 backoff */
  delayMs: number;
  /** 最大重试次数（超过则 abort） */
  maxRetries: number;
}

/** 错误分类结果 */
export interface ErrorClassification {
  type: ErrorType;
  confidence: number; // 0-1
  reason: string;
}

/**
 * Error Taxonomy — 错误分类器
 *
 * 【学习要点】
 * 用关键词模式匹配做快速分类，confidence 表示确信度。
 * 高确信度直接用分类结果，低确信度可以降级到通用恢复策略。
 */
export class ErrorTaxonomy {
  private logger = getLogger();

  /**
   * 从工具结果中分类错误
   */
  classify(toolCall: ToolCall, result: ToolResult): ErrorClassification {
    const errorText = (result.error ?? "").toLowerCase();
    const toolName = toolCall.name.toLowerCase();

    // 1. 超时
    if (errorText.includes("timeout") || errorText.includes("timed out")) {
      return { type: ErrorType.TIMEOUT, confidence: 0.95, reason: "Operation timed out" };
    }

    // 2. 速率限制
    if (errorText.includes("rate limit") || errorText.includes("429") || errorText.includes("too many requests")) {
      return { type: ErrorType.RATE_LIMIT, confidence: 0.95, reason: "Rate limit hit" };
    }

    // 3. 权限错误
    if (
      errorText.includes("permission") ||
      errorText.includes("eacces") ||
      errorText.includes("eperm") ||
      errorText.includes("access denied")
    ) {
      return { type: ErrorType.PERMISSION_ERROR, confidence: 0.9, reason: "Permission denied" };
    }

    // 4. 文件不存在
    if (errorText.includes("enoent") || errorText.includes("no such file") || errorText.includes("file not found")) {
      return { type: ErrorType.TOOL_ERROR, confidence: 0.9, reason: "File not found" };
    }

    // 5. 上下文溢出
    if (
      errorText.includes("context_length") ||
      errorText.includes("context window") ||
      errorText.includes("too many tokens") ||
      errorText.includes("maximum context")
    ) {
      return { type: ErrorType.CONTEXT_OVERFLOW, confidence: 0.9, reason: "Context window exceeded" };
    }

    // 6. 网络错误
    if (
      errorText.includes("network") ||
      errorText.includes("econnrefused") ||
      errorText.includes("econnreset") ||
      errorText.includes("fetch failed") ||
      errorText.includes("dns")
    ) {
      return { type: ErrorType.NETWORK_ERROR, confidence: 0.85, reason: "Network error" };
    }

    // 7. Schema / 参数错误
    if (
      errorText.includes("invalid parameter") ||
      errorText.includes("schema") ||
      errorText.includes("validation") ||
      errorText.includes("required field")
    ) {
      return { type: ErrorType.SCHEMA_ERROR, confidence: 0.8, reason: "Invalid parameters" };
    }

    // 8. 检查 shell exit code 1 (可能多种原因，归为 tool_error)
    if (errorText.includes("exit 1") || errorText.includes("exit code 1")) {
      return { type: ErrorType.TOOL_ERROR, confidence: 0.6, reason: "Command exited with code 1" };
    }

    // 9. 兜底 — 通用工具错误
    return { type: ErrorType.TOOL_ERROR, confidence: 0.5, reason: result.error ?? "Unknown error" };
  }

  /**
   * 根据错误分类制定恢复策略
   */
  getRecoveryPlan(classification: ErrorClassification, retryCount: number): RecoveryPlan {
    const { type, reason } = classification;

    switch (type) {
      case ErrorType.TOOL_ERROR:
        return {
          action: RecoveryAction.RETRY_WITH_ALTERNATIVE,
          hintForLLM: `Tool "${reason}" failed. Try a different approach: use a different file path, different tool, or ask the user for the correct path.`,
          countsAsRetry: true,
          delayMs: 0,
          maxRetries: 3,
        };

      case ErrorType.VALIDATION_ERROR:
      case ErrorType.SCHEMA_ERROR:
        return {
          action: RecoveryAction.REGENERATE_PARAMS,
          hintForLLM: `Parameters were invalid. Regenerate tool call with corrected parameters.`,
          countsAsRetry: true,
          delayMs: 0,
          maxRetries: 2,
        };

      case ErrorType.PERMISSION_ERROR:
        return {
          action: RecoveryAction.REQUEST_PERMISSION,
          hintForLLM: `Permission denied. This operation requires elevated access. Tell the user what you need and ask for help.`,
          countsAsRetry: false, // 权限问题不算重试
          delayMs: 0,
          maxRetries: 1,
        };

      case ErrorType.TIMEOUT:
        return {
          action: RecoveryAction.RETRY_WITH_SMALLER_SCOPE,
          hintForLLM: `Operation timed out. Try reducing the scope: read fewer lines, search in a specific directory, or use a shorter command.`,
          countsAsRetry: true,
          delayMs: 1000,
          maxRetries: 2,
        };

      case ErrorType.RATE_LIMIT: {
        const backoffMs = Math.min(30000, 2000 * 2 ** retryCount);
        return {
          action: RecoveryAction.BACKOFF_AND_RETRY,
          hintForLLM: `Rate limit hit. Wait ${Math.round(backoffMs / 1000)}s before retrying.`,
          countsAsRetry: true,
          delayMs: backoffMs,
          maxRetries: 5,
        };
      }

      case ErrorType.CONTEXT_OVERFLOW:
        return {
          action: RecoveryAction.COMPRESS_CONTEXT,
          hintForLLM: `Context window exceeded. You need to compress previous conversation or read smaller chunks.`,
          countsAsRetry: false,
          delayMs: 0,
          maxRetries: 1,
        };

      case ErrorType.NETWORK_ERROR:
        return {
          action: RecoveryAction.SIMPLE_RETRY,
          hintForLLM: `Network error. This may be temporary. Retry in a moment.`,
          countsAsRetry: true,
          delayMs: 3000,
          maxRetries: 3,
        };

      case ErrorType.HALLUCINATION:
        return {
          action: RecoveryAction.CORRECT_AND_RETRY,
          hintForLLM: `The tool call referenced something that doesn't exist. Verify the file path or tool name and try again.`,
          countsAsRetry: true,
          delayMs: 0,
          maxRetries: 2,
        };

      default:
        return {
          action: RecoveryAction.SKIP_AND_REPLAN,
          hintForLLM: `An unexpected error occurred. Try a different approach or tell the user what happened.`,
          countsAsRetry: true,
          delayMs: 0,
          maxRetries: 2,
        };
    }
  }

  /**
   * 判断是否应该继续重试
   */
  shouldRetry(plan: RecoveryPlan, retryCount: number): boolean {
    return retryCount < plan.maxRetries;
  }
}
