/**
 * Agent Core - ReAct 循环实现
 *
 * ============================================================
 * Phase 1: ReAct 循环 + 循环控制 + Doom Loop
 * Phase 2: 审批网关 + Observation Layer
 * Phase 3: State Machine + Error Taxonomy + Reflection
 * Phase 4.6: Runtime Metrics + Context History Checkpoints
 * ============================================================
 */

import type { LLMAdapter, Message } from "../llm/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCall } from "../tools/types.js";
import { ApprovalGateway, type ApprovalCallback } from "./approval-gateway.js";
import { ObservationManager } from "./observation.js";
import { StateMachine, ExecutionStatus } from "./state-machine.js";
import { ErrorTaxonomy, RecoveryAction } from "./error-taxonomy.js";
import { ReflectionEngine, type ReflectionJSON } from "./reflection.js";
import { WorkingMemory } from "./working-memory.js";
import { ContextAssembler } from "./context-assembler.js";
import { RuntimeMetrics } from "./runtime-metrics.js";
import { TaskRouter } from "./task-router.js";
import { TaskPlanner, type TaskPlan } from "./task-planner.js";
import { StepExecutor, type PlanExecutionResult } from "./step-executor.js";
import { getLogger } from "../utils/logger.js";

export interface AgentConfig {
  maxIterations?: number;
  systemPrompt?: string;
  showThinking?: boolean;
  maxToolOutputChars?: number;
  doomLoopThreshold?: number;
  enableApproval?: boolean;
  onConfirm?: ApprovalCallback;
}

const DEFAULT_SYSTEM_PROMPT = `You are a CLI coding agent. You help users with coding tasks by using tools.

## Core Principles
1. **Think before acting**: Always explain your reasoning before using a tool.
2. **Be efficient**: Use the cheapest tool first (e.g., grep before reading entire files).
3. **Be safe**: Always read before writing. Never overwrite without checking.
4. **Be precise**: Use specific line ranges when reading files.

## CRITICAL: When to Stop
- **STOP when the task is done.** Give your final answer immediately. Do NOT do extra work.
- After completing the user's request, respond with your answer. Do NOT call more tools.
- If you've gathered enough information to answer, ANSWER. Do not explore further.

## CRITICAL: Verification Rules
- If you modified code, you MUST verify it works (run it, check syntax, etc.)
- Never claim "done" without verification.
- If verification fails, fix it before responding.

## CRITICAL: Failure Handling
- If a tool fails, read the error message and try a different approach.
- If you fail 2-3 times on the same thing, STOP and tell the user what went wrong.
- Do NOT keep retrying the exact same approach.

## Tool Usage Guidelines
- Use \`file_summary\` to understand a file before reading it
- Use \`grep\` to find where something is before reading files
- Use \`read_file\` with start/end lines for large files
- Use \`list_dir\` to explore project structure
- Use \`git_status\` and \`git_diff\` to understand changes

## Token Economy
- Always prefer searching (grep) over reading entire files
- Use file_summary before reading large files
- Specify line ranges when reading files`;

export interface AgentState {
  messages: Message[];
  currentStep: number;
  totalTokens: number;
  toolCallHistory: Array<{
    step: number;
    toolCall: ToolCall;
    result: unknown;
  }>;
}

class DoomLoopDetector {
  private recentFailures: Map<string, number> = new Map();
  private threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  record(toolCall: ToolCall, success: boolean): boolean {
    if (success) {
      this.recentFailures.delete(toolCall.name);
      return false;
    }
    const key = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
    const count = (this.recentFailures.get(key) ?? 0) + 1;
    this.recentFailures.set(key, count);
    return count >= this.threshold;
  }

  reset(): void {
    this.recentFailures.clear();
  }
}


/** 运行时快照 — 支持 checkpoint / resume / replay */
export interface RuntimeSnapshot {
  agentState: AgentState;
  stateMachine: ReturnType<StateMachine["snapshot"]>;
  workingMemory: ReturnType<WorkingMemory["snapshot"]>;
  reflection: ReflectionJSON;
  timestamp: number;
}

/** 运行报告 — 标准化输出，方便评估体系 */
export interface RunReport {
  goal: string;
  finalStatus: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  steps: number;
  tokens: number;
  toolCalls: number;
  retries: number;
  reflections: number;
  toolUsage: Record<string, number>;
  failureCategories: Record<string, number>;
  warnings: string[];
}
export class Agent {
  private llm: LLMAdapter;
  private tools: ToolRegistry;
  private gateway: ApprovalGateway;
  private observer: ObservationManager;
  private stateMachine: StateMachine;
  private errorTaxonomy: ErrorTaxonomy;
  private reflectionEngine: ReflectionEngine;
  private workingMemory: WorkingMemory;
  private contextAssembler: ContextAssembler;
  private config: Required<AgentConfig>;
  private state: AgentState;
  private doomLoopDetector: DoomLoopDetector;
  private lastRunMetrics?: RuntimeMetrics;
  private taskRouter?: TaskRouter;
  private taskPlanner?: TaskPlanner;
  private stepExecutor?: StepExecutor;
  private logger = getLogger();

  constructor(llm: LLMAdapter, tools: ToolRegistry, config?: AgentConfig) {
    this.llm = llm;
    this.tools = tools;
    this.config = {
      maxIterations: config?.maxIterations ?? 20,
      systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      showThinking: config?.showThinking ?? true,
      maxToolOutputChars: config?.maxToolOutputChars ?? 3000,
      doomLoopThreshold: config?.doomLoopThreshold ?? 3,
      enableApproval: config?.enableApproval ?? true,
      onConfirm: config?.onConfirm ?? (async () => false),
    };

    this.doomLoopDetector = new DoomLoopDetector(this.config.doomLoopThreshold);
    this.gateway = new ApprovalGateway(tools, {
      enabled: this.config.enableApproval,
      onConfirm: this.config.onConfirm,
    });
    this.observer = new ObservationManager();
    this.stateMachine = new StateMachine();
    this.errorTaxonomy = new ErrorTaxonomy();
    this.reflectionEngine = new ReflectionEngine();
    this.workingMemory = new WorkingMemory();
    this.contextAssembler = new ContextAssembler();

    this.state = {
      messages: [
        { role: "system", content: this.config.systemPrompt },
      ],
      currentStep: 0,
      totalTokens: 0,
      toolCallHistory: [],
    };
  }

  private truncateToolOutput(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    const headSize = Math.floor(maxChars * 0.6);
    const tailSize = Math.floor(maxChars * 0.3);
    const head = output.slice(0, headSize);
    const tail = output.slice(-tailSize);
    return `${head}\n\n... [truncated ${output.length - headSize - tailSize} chars] ...\n\n${tail}`;
  }

  async run(userMessage: string): Promise<string> {
    this.state.messages.push({ role: "user", content: userMessage });

    this.stateMachine.setGoal(userMessage);
    this.workingMemory.setGoal(userMessage);
    this.lastRunMetrics = new RuntimeMetrics(userMessage, this.workingMemory.version);
    this.stateMachine.transition(ExecutionStatus.EXECUTING);

    for (let i = 0; i < this.config.maxIterations; i++) {
      this.state.currentStep++;
      this.lastRunMetrics.markLoop();
      this.logger.info("Agent", `Step ${this.state.currentStep}/${this.config.maxIterations}`);

      this.workingMemory.setCurrentStep(this.state.currentStep);
      this.workingMemory.tickStep(this.state.currentStep);

      const assembled = this.contextAssembler.assemble(
        this.state.messages,
        this.workingMemory,
        this.stateMachine,
        this.state.currentStep
      );

      this.lastRunMetrics.recordContextReport({
        compressedMessages: assembled.report.compressedMessages,
        droppedForBudget: assembled.report.droppedForBudget,
        contextVersion: assembled.report.contextVersion,
      });
      this.lastRunMetrics.setWorkingMemoryVersion(this.workingMemory.version);
      this.lastRunMetrics.setTotalSteps(this.stateMachine.snapshot().totalSteps);
      this.logger.info(
        "ContextAssembler",
        `ctx=${assembled.report.contextVersion}, msgs=${assembled.report.totalMessages}, tokens=${assembled.report.estimatedTotalTokens}, compressed=${assembled.report.compressedMessages}, dropped=${assembled.report.droppedForBudget}`
      );

      const response = await this.llm.chat(
        assembled.messages,
        this.tools.getToolDefinitions()
      );

      if (response.usage) {
        this.state.totalTokens += response.usage.totalTokens;
        this.stateMachine.addTokens(response.usage.totalTokens);
        this.lastRunMetrics.recordUsage(
          response.usage.promptTokens ?? 0,
          response.usage.completionTokens ?? 0,
          response.usage.totalTokens
        );
        this.logger.info("Agent", `Tokens: +${response.usage.totalTokens} (total: ${this.state.totalTokens})`);
      }

      if (response.toolCalls.length === 0) {
        this.logger.info("Agent", "Task completed");
        this.stateMachine.transition(ExecutionStatus.COMPLETED);
        this.state.messages.push({ role: "assistant", content: response.content });
        this.lastRunMetrics.setFinalStatus("completed");
        this.lastRunMetrics.finish("completed");
        return response.content;
      }

      if (this.config.showThinking && response.content) {
        this.logger.info("Agent Thinking", response.content);
      }

      this.state.messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        this.lastRunMetrics.recordToolCall(toolCall.name);
        this.logger.info("Agent", `Tool: ${toolCall.name}`, toolCall.arguments);

        const startTime = Date.now();
        const result = await this.gateway.execute(toolCall);
        const durationMs = Date.now() - startTime;

        this.logger.info("Agent", `Result: ${result.success ? "OK" : "FAIL"}`, {
          tokenEstimate: result.tokenEstimate,
        });

        const isDoomLoop = this.doomLoopDetector.record(toolCall, result.success);
        if (isDoomLoop) {
          this.lastRunMetrics.setFinalStatus("doom_loop");
          this.lastRunMetrics.finish("doom_loop");
          this.stateMachine.transition(ExecutionStatus.FAILED);
          const errorMsg = `Doom loop detected: "${toolCall.name}" failed ${this.config.doomLoopThreshold} times. Stopping.`;
          this.logger.warn("Agent", errorMsg);
          this.state.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: errorMsg,
              instruction: "STOP. Do not retry this tool. Tell the user what went wrong."
            }),
          });
          continue;
        }

        this.state.toolCallHistory.push({
          step: this.state.currentStep,
          toolCall,
          result: result.data || result.error,
        });

        if (result.success) {
          this.stateMachine.recordStep({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            success: true,
            errorType: undefined,
            durationMs,
          });
          this.stateMachine.resetRetry();
          this.reflectionEngine.recordOutcome(toolCall.name, true);

          const filePath = (toolCall.arguments.path as string) ?? undefined;
          this.workingMemory.addFinding({
            content: `Tool ${toolCall.name} succeeded${filePath ? ` for ${filePath}` : ""}`,
            source: { kind: "tool", toolName: toolCall.name, toolCallId: toolCall.id, stepId: this.state.currentStep, filePath },
            file: filePath,
            importance: "low",
            confidence: 0.78,
            strength: 8,
            tags: [toolCall.name, filePath ?? ""].filter(Boolean),
          });
          if (filePath) {
            this.workingMemory.addActiveFile(filePath);
            this.workingMemory.reinforceByFile(filePath, 1);
          }
        } else {
          const classification = this.errorTaxonomy.classify(toolCall, result);
          const recovery = this.errorTaxonomy.getRecoveryPlan(classification, 0);
          this.lastRunMetrics.recordFailureCategory(classification.type);

          this.stateMachine.recordFailure({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            success: false,
            errorType: classification.type,
            durationMs,
          });
          this.reflectionEngine.recordOutcome(toolCall.name, false);

          const failPath = (toolCall.arguments.path as string) ?? undefined;
          this.workingMemory.addError(`${toolCall.name}: ${classification.type}${failPath ? ` (${failPath})` : ""}`);
          this.workingMemory.addFinding({
            content: `${toolCall.name} failed with ${classification.type}`,
            source: { kind: "observation", toolName: toolCall.name, toolCallId: toolCall.id, stepId: this.state.currentStep, filePath: failPath },
            file: failPath,
            importance: "medium",
            confidence: 0.76,
            strength: 9,
            tags: ["failure", toolCall.name, classification.type],
          });
          if (failPath) this.workingMemory.demoteByFile(failPath, 2);

          const snapshot = this.stateMachine.snapshot();
          const reflection = this.reflectionEngine.check(snapshot, {
            type: classification.type,
            recovery: recovery.action,
          });

          if (reflection.shouldReflect && reflection.promptForLLM) {
            this.lastRunMetrics.recordReflection();
            this.logger.warn("Agent", `Reflection triggered: ${reflection.trigger}`);
            this.stateMachine.transition(ExecutionStatus.REFLECTING);
            this.stateMachine.addReflection({
              stepId: this.state.currentStep,
              trigger: reflection.trigger!,
              diagnosis: reflection.diagnosis ?? "",
              newStrategy: reflection.newStrategy ?? "",
            });

            this.state.messages.push({
              role: "user",
              content: reflection.promptForLLM,
            });
            this.stateMachine.transition(ExecutionStatus.EXECUTING);
          }

          if (recovery.action !== RecoveryAction.ABORT) {
            this.lastRunMetrics.recordRetry();
            this.logger.info("Agent", `Recovery: ${recovery.action} — ${recovery.hintForLLM}`);
            this.stateMachine.incrementRetry();
          }
        }

        const observation = this.observer.observe(toolCall, result);
        let outputStr = this.observer.formatForLLM(observation);
        outputStr = this.truncateToolOutput(outputStr, this.config.maxToolOutputChars);

        if (!result.success) {
          const classification = this.errorTaxonomy.classify(toolCall, result);
          const recovery = this.errorTaxonomy.getRecoveryPlan(classification, this.stateMachine.snapshot().retryCount);
          if (recovery.action !== RecoveryAction.ABORT) {
            outputStr += `\n\n**Recovery suggestion**: ${recovery.hintForLLM}`;
          }
        }

        this.state.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: outputStr,
        });
      }
    }

    this.lastRunMetrics.setFinalStatus("max_iterations");
    this.lastRunMetrics.finish("max_iterations");
    this.stateMachine.transition(ExecutionStatus.FAILED);
    this.state.messages.push({
      role: "user",
      content: "You have reached the maximum number of steps. Please summarize what you have done so far and what remains unfinished.",
    });

    try {
      const finalAssembled = this.contextAssembler.assemble(
        this.state.messages,
        this.workingMemory,
        this.stateMachine,
        this.state.currentStep
      );
      const finalResponse = await this.llm.chat(finalAssembled.messages, []);
      return finalResponse.content || `Reached maximum iterations (${this.config.maxIterations}).`;
    } catch {
      return `Reached maximum iterations (${this.config.maxIterations}).`;
    }
  }

  getGateway(): ApprovalGateway {
    return this.gateway;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getStateMachine(): StateMachine {
    return this.stateMachine;
  }

  getErrorTaxonomy(): ErrorTaxonomy {
    return this.errorTaxonomy;
  }

  getReflectionEngine(): ReflectionEngine {
    return this.reflectionEngine;
  }

  getWorkingMemory(): WorkingMemory {
    return this.workingMemory;
  }

  getContextAssembler(): ContextAssembler {
    return this.contextAssembler;
  }

  getLastRunMetrics(): RuntimeMetrics | undefined {
    return this.lastRunMetrics;
  }

  reset(): void {
    this.state = {
      messages: [
        { role: "system", content: this.config.systemPrompt },
      ],
      currentStep: 0,
      totalTokens: 0,
      toolCallHistory: [],
    };
    this.doomLoopDetector.reset();
    this.stateMachine.reset();
    this.reflectionEngine.reset();
    this.workingMemory.reset();
    this.lastRunMetrics = undefined;
  }

  /**
   * 步骤级重置：清除执行状态，保留 Working Memory
   *
   * 用于 runPlanned() 中每个步骤之间：
   * - StateMachine 重置到 planning（避免终态阻塞）
   * - Agent state 清空（避免 step 计数累加）
   * - DoomLoop / Reflection 重置
   * - Working Memory 保留（跨步骤共享上下文）
   */
  resetForStep(): void {
    this.state = {
      messages: [{ role: "system", content: this.config.systemPrompt }],
      currentStep: 0,
      totalTokens: 0,
      toolCallHistory: [],
    };
    this.doomLoopDetector.reset();
    this.stateMachine.reset();
    this.reflectionEngine.reset();
    this.lastRunMetrics = undefined;
  }
  /** 动态调整最大迭代数（用于 plan step 限制） */
  setMaxIterations(n: number): void {
    this.config.maxIterations = n;
  }
  /** 创建运行时快照（支持 checkpoint / resume / replay） */
  snapshot(): RuntimeSnapshot {
    return {
      agentState: {
        messages: this.state.messages.map((m) => ({ ...m })),
        currentStep: this.state.currentStep,
        totalTokens: this.state.totalTokens,
        toolCallHistory: this.state.toolCallHistory.map((h) => ({ ...h })),
      },
      stateMachine: this.stateMachine.snapshot(),
      workingMemory: this.workingMemory.snapshot(),
      reflection: this.reflectionEngine.toJSON(),
      timestamp: Date.now(),
    };
  }

  /** 从快照恢复状态（支持 checkpoint / resume） */
  restore(snap: RuntimeSnapshot): void {
    this.state = {
      messages: snap.agentState.messages.map((m) => ({ ...m })),
      currentStep: snap.agentState.currentStep,
      totalTokens: snap.agentState.totalTokens,
      toolCallHistory: snap.agentState.toolCallHistory.map((h) => ({ ...h })),
    };
    this.stateMachine.loadSnapshot(snap.stateMachine);
    this.workingMemory.loadSnapshot(snap.workingMemory);
    this.reflectionEngine.loadJSON(snap.reflection);
    this.logger.info("Agent", `Restored snapshot from ${new Date(snap.timestamp).toISOString()}, step=${snap.agentState.currentStep}`);
  }

  /**
   * 带规划的执行：分解任务 → 逐步执行 → 失败时重规划
   */
  async runPlanned(goal: string): Promise<PlanExecutionResult> {
    this.logger.info("Agent", `Starting planned run: ${goal}`);

    // 初始化 TaskPlanner 和 StepExecutor（懒加载）
    if (!this.taskPlanner) {
      this.taskPlanner = new TaskPlanner(this.llm);
    }
    if (!this.stepExecutor) {
      this.stepExecutor = new StepExecutor({
        maxIterationsPerStep: this.taskPlanner.maxIterationsPerStep,
      });
    }

    // Phase 1: 规划
    const plan = await this.taskPlanner.plan(goal, this.workingMemory);

    // Phase 2: 逐步执行（每步前重置执行状态，保留 Working Memory）
    let result = await this.stepExecutor.executeWithReset(plan, this, this.workingMemory);

    // Phase 3: 如果有失败步骤，尝试重规划一次
    if (result.finalStatus !== "completed") {
      const failedSteps = result.plan.steps.filter((s) => s.status === "failed");
      if (failedSteps.length > 0) {
        const lastFailed = failedSteps[failedSteps.length - 1];
        this.logger.info("Agent", `Replanning after step ${lastFailed.id} failed`);

        try {
          const newPlan = await this.taskPlanner.replan(
            result.plan,
            lastFailed,
            lastFailed.result ?? "Step failed",
            this.workingMemory
          );
          result = await this.stepExecutor.executeWithReset(newPlan, this, this.workingMemory);
        } catch (e) {
          this.logger.warn("Agent", `Replan failed: ${e}`);
        }
      }
    }

    this.logger.info(
      "Agent",
      `Planned run finished: ${result.completedSteps}/${result.totalSteps} steps, status=${result.finalStatus}`
    );

    return result;
  }

  getTaskPlanner(): TaskPlanner | undefined {
    return this.taskPlanner;
  }

  getStepExecutor(): StepExecutor | undefined {
    return this.stepExecutor;
  }
  /** 导出运行报告 JSON（方便后续做评估体系） */
  exportRunReport(): RunReport {
    const metrics = this.lastRunMetrics?.currentSnapshot();
    const now = Date.now();
    return {
      goal: metrics?.goal ?? this.stateMachine.currentGoal,
      finalStatus: metrics?.finalStatus ?? this.stateMachine.status,
      startedAt: metrics?.startedAt ?? now,
      finishedAt: metrics?.finishedAt ?? now,
      durationMs: metrics?.durationMs ?? 0,
      steps: this.stateMachine.snapshot().totalSteps,
      tokens: this.state.totalTokens,
      toolCalls: metrics?.toolCalls ?? 0,
      retries: metrics?.retries ?? 0,
      reflections: metrics?.reflections ?? 0,
      toolUsage: metrics?.toolUsage ?? {},
      failureCategories: metrics?.failureCategories ?? {},
      warnings: metrics?.warnings ?? [],
    };
  }
}









