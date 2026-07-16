/**
 * Agent Core - ReAct 循环实现
 * 
 * ============================================================
 * Phase 1: ReAct 循环 + 循环控制 + Doom Loop
 * Phase 2: 审批网关 + Observation Layer
 * Phase 3: State Machine + Error Taxonomy + Reflection
 * Phase 4: Working Memory + Context Assembler
 * ============================================================
 */

import type { LLMAdapter, Message } from "../llm/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCall } from "../tools/types.js";
import { ApprovalGateway, type ApprovalCallback } from "./approval-gateway.js";
import { ObservationManager } from "./observation.js";
import { StateMachine, ExecutionStatus } from "./state-machine.js";
import { ErrorTaxonomy, RecoveryAction } from "./error-taxonomy.js";
import { ReflectionEngine } from "./reflection.js";
import { WorkingMemory } from "./working-memory.js";
import { ContextAssembler } from "./context-assembler.js";
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

    // Phase 3 + 4: 设置目标
    this.stateMachine.setGoal(userMessage);
    this.workingMemory.setGoal(userMessage);
    this.stateMachine.transition(ExecutionStatus.EXECUTING);

    for (let i = 0; i < this.config.maxIterations; i++) {
      this.state.currentStep++;
      this.logger.info("Agent", `Step ${this.state.currentStep}/${this.config.maxIterations}`);

      // Phase 4: 通过 Context Assembler 组装上下文
      const assembled = this.contextAssembler.assemble(
        this.state.messages,
        this.workingMemory,
        this.stateMachine
      );
      this.logger.info("ContextAssembler", `Messages: ${assembled.stats.totalMessages}, Tokens: ~${assembled.stats.estimatedTotalTokens}, Compressed: ${assembled.stats.compressedMessages}`);

      const response = await this.llm.chat(
        assembled.messages,
        this.tools.getToolDefinitions()
      );

      if (response.usage) {
        this.state.totalTokens += response.usage.totalTokens;
        this.stateMachine.addTokens(response.usage.totalTokens);
        this.logger.info("Agent", `Tokens: +${response.usage.totalTokens} (total: ${this.state.totalTokens})`);
      }

      if (response.toolCalls.length === 0) {
        this.logger.info("Agent", "Task completed");
        this.stateMachine.transition(ExecutionStatus.COMPLETED);
        this.state.messages.push({
          role: "assistant",
          content: response.content,
        });
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
        this.logger.info("Agent", `Tool: ${toolCall.name}`, toolCall.arguments);

        const startTime = Date.now();
        const result = await this.gateway.execute(toolCall);
        const durationMs = Date.now() - startTime;

        this.logger.info("Agent", `Result: ${result.success ? "OK" : "FAIL"}`, {
          tokenEstimate: result.tokenEstimate,
        });

        // Doom Loop 检测
        const isDoomLoop = this.doomLoopDetector.record(toolCall, result.success);
        if (isDoomLoop) {
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

        // === Phase 3: State Machine + Error Taxonomy + Reflection ===

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

          // Phase 4: 更新 Working Memory
          this.workingMemory.addFinding({
            content: `Tool ${toolCall.name} succeeded`,
            source: toolCall.name,
            file: (toolCall.arguments.path as string) ?? undefined,
            importance: "low",
          });
          const filePath = toolCall.arguments.path as string | undefined;
          if (filePath) this.workingMemory.addActiveFile(filePath);
        } else {
          const classification = this.errorTaxonomy.classify(toolCall, result);
          const recovery = this.errorTaxonomy.getRecoveryPlan(classification, 0);

          this.stateMachine.recordFailure({
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            success: false,
            errorType: classification.type,
            durationMs,
          });
          this.reflectionEngine.recordOutcome(toolCall.name, false);

          // Phase 4: 更新 Working Memory
          this.workingMemory.addError(`${toolCall.name}: ${classification.type}`);

          // 检查是否需要反思
          const snapshot = this.stateMachine.snapshot();
          const reflection = this.reflectionEngine.check(snapshot, {
            type: classification.type,
            recovery: recovery.action,
          });

          if (reflection.shouldReflect && reflection.promptForLLM) {
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
            this.logger.info("Agent", `Recovery: ${recovery.action} — ${recovery.hintForLLM}`);
            this.stateMachine.incrementRetry();
          }
        }

        // 通过 Observation 层提取结构化观察
        const observation = this.observer.observe(toolCall, result);
        let outputStr = this.observer.formatForLLM(observation);
        outputStr = this.truncateToolOutput(outputStr, this.config.maxToolOutputChars);

        // Phase 3: 失败时附加恢复策略提示
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

    // 达到最大循环次数
    this.stateMachine.transition(ExecutionStatus.FAILED);
    this.state.messages.push({
      role: "user",
      content: "You have reached the maximum number of steps. Please summarize what you have done so far and what remains unfinished.",
    });
    
    try {
      const finalAssembled = this.contextAssembler.assemble(
        this.state.messages,
        this.workingMemory,
        this.stateMachine
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

  /** Phase 4: 获取工作记忆 */
  getWorkingMemory(): WorkingMemory {
    return this.workingMemory;
  }

  /** Phase 4: 获取上下文组装器 */
  getContextAssembler(): ContextAssembler {
    return this.contextAssembler;
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
  }
}
