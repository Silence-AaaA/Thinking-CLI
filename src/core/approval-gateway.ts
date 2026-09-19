/**
 * 分级审批系统 - 审批网关
 *
 * ============================================================
 * 这是工具执行的"守门人"
 * 所有工具调用都必须经过这里
 * ============================================================
 *
 * 【设计要点】
 * RiskAssessor 负责"评估风险"
 * ApprovalGateway 负责"根据风险做决定"
 *
 * 分离的好处：
 * - 风险评估是纯逻辑，可以单元测试
 * - 审批网关负责和用户交互（如确认弹窗）
 * - 两者可以独立演进
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { getLogger } from "../utils/logger.js";
import { ApprovalDecision, RiskAssessor, RiskLevel } from "./risk-assessor.js";

/** 审批回调函数类型 */
export type ApprovalCallback = (
  toolCall: ToolCall,
  assessment: {
    level: RiskLevel;
    reason: string;
    risks: string[];
  },
) => Promise<boolean>; // true = 用户批准, false = 用户拒绝

/** 审批网关配置 */
export interface ApprovalGatewayConfig {
  /** 是否启用审批（false = 全部放行，开发模式） */
  enabled?: boolean;
  /** 用户确认回调（如果不提供，CONFRIM 操作会被拒绝） */
  onConfirm?: ApprovalCallback;
}

/**
 * 审批网关 — 工具执行的守门人
 *
 * 【工作流程】
 * 1. LLM 返回 tool_call
 * 2. RiskAssessor 评估风险等级
 * 3. ApprovalGateway 根据等级做决定：
 *    - READ → 直接放行
 *    - WRITE → 记录日志，放行
 *    - EXECUTE → 白名单校验，放行
 *    - DESTRUCTIVE → 调用 onConfirm 回调（可能阻塞等用户）
 *    - BLOCKED → 直接拒绝
 * 4. 执行或拒绝
 *
 * 【学习要点】
 * 这个模式叫 "Gateway Pattern" 或 "Middleware Pattern"。
 * 在工具和执行之间插入一个决策层。
 * 这是所有安全系统的核心设计模式。
 */
export class ApprovalGateway {
  private registry: ToolRegistry;
  private assessor: RiskAssessor;
  private config: Required<ApprovalGatewayConfig>;
  private logger = getLogger();

  /** 审计日志 */
  private auditLog: Array<{
    timestamp: string;
    toolCall: ToolCall;
    riskLevel: RiskLevel;
    decision: ApprovalDecision;
    reason: string;
    risks: string[];
    result?: "executed" | "denied" | "error";
  }> = [];

  constructor(registry: ToolRegistry, config?: ApprovalGatewayConfig) {
    this.registry = registry;
    this.assessor = new RiskAssessor();
    this.config = {
      enabled: config?.enabled ?? true,
      onConfirm: config?.onConfirm ?? (async () => false), // 默认拒绝需要确认的操作
    };
  }

  /**
   * 执行工具调用（带审批）
   *
   * 这是对外的唯一接口，替代直接调用 registry.execute()
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    // Step 1: 评估风险
    const assessment = this.assessor.assess(toolCall);

    // Step 2: 记录审计日志
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      toolCall,
      riskLevel: assessment.level,
      decision: assessment.decision,
      reason: assessment.reason,
      risks: assessment.risks,
    });

    this.logger.info("ApprovalGateway", `Risk: ${assessment.level} | Decision: ${assessment.decision}`, {
      tool: toolCall.name,
      reason: assessment.reason,
      risks: assessment.risks,
    });

    // Step 3: 根据决定处理
    if (!this.config.enabled) {
      // 开发模式：全部放行
      return this.registry.execute(toolCall);
    }

    switch (assessment.decision) {
      case ApprovalDecision.ALLOW:
        // 自动放行
        this.auditLog[this.auditLog.length - 1]!.result = "executed";
        return this.registry.execute(toolCall);

      case ApprovalDecision.CONFIRM: {
        // 需要用户确认
        this.logger.warn("ApprovalGateway", `⚠️  Requires confirmation: ${assessment.reason}`);
        if (assessment.risks.length > 0) {
          this.logger.warn("ApprovalGateway", `Risks: ${assessment.risks.join("; ")}`);
        }

        const approved = await this.config.onConfirm(toolCall, assessment);

        if (approved) {
          this.logger.info("ApprovalGateway", "User approved");
          this.auditLog[this.auditLog.length - 1]!.result = "executed";
          return this.registry.execute(toolCall);
        } else {
          this.logger.warn("ApprovalGateway", "User denied");
          this.auditLog[this.auditLog.length - 1]!.result = "denied";
          return {
            success: false,
            error: `Operation denied by user: ${assessment.reason}. Try a safer approach.`,
          };
        }
      }

      case ApprovalDecision.DENY:
        // 直接拒绝
        this.logger.warn("ApprovalGateway", `🚫 Blocked: ${assessment.reason}`);
        this.auditLog[this.auditLog.length - 1]!.result = "denied";
        return {
          success: false,
          error: `Operation blocked: ${assessment.reason}. This command is not allowed for safety reasons.`,
        };

      default:
        return this.registry.execute(toolCall);
    }
  }

  /**
   * 获取审计日志（用于调试和审计）
   */
  getAuditLog() {
    return [...this.auditLog];
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.auditLog.length;
    const byLevel = {
      [RiskLevel.READ]: 0,
      [RiskLevel.WRITE]: 0,
      [RiskLevel.EXECUTE]: 0,
      [RiskLevel.DESTRUCTIVE]: 0,
      [RiskLevel.BLOCKED]: 0,
    };
    const byResult = { executed: 0, denied: 0, error: 0 };

    for (const entry of this.auditLog) {
      byLevel[entry.riskLevel]++;
      if (entry.result) byResult[entry.result]++;
    }

    return { total, byLevel, byResult };
  }
}
