#!/usr/bin/env node

/**
 * Thinking Agent - CLI 入口
 *
 * Phase 3 (审批): --no-approval 模式 / audit / stats
 * Phase 3 (执行): exec 命令查看执行引擎状态
 * Phase 4.6: wm / ctx / metrics / ctxdiff
 *
 * 【v2 修复】审批确认不再创建新的 readline，复用 REPL 的 rl
 * 防止 "y" 被 REPL 捕获当成新的用户任务
 */

import { Command } from "commander";
import * as readline from "readline";
import { Agent } from "../core/agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { fileTools } from "../tools/file-tools.js";
import { searchTools } from "../tools/search-tools.js";
import { shellTools } from "../tools/shell-tool.js";
import { gitTools } from "../tools/git-tools.js";
import { OpenAIAdapter } from "../llm/openai-adapter.js";
import { initLogger, LogLevel } from "../utils/logger.js";
import type { ToolCall } from "../tools/types.js";
import type { RiskLevel } from "../core/risk-assessor.js";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();

program
  .name("thinking-agent")
  .description("A CLI coding agent built for learning Agent architecture")
  .version("0.4.6");

program
  .argument("[task]", "Task to execute (omit for REPL mode)")
  .option("--repl", "Start interactive REPL mode")
  .option("--model <model>", "LLM model to use", process.env.OPENAI_MODEL || "gpt-4o")
  .option("--max-iterations <n>", "Max ReAct iterations", "20")
  .option("--verbose", "Enable verbose logging")
  .option("--log-dir <dir>", "Directory to save logs")
  .option("--no-approval", "Disable approval system (dev mode)")
  .action(async (task: string | undefined, options) => {
    const logLevel = options.verbose ? LogLevel.DEBUG : LogLevel.INFO;
    const logger = initLogger(logLevel, options.logDir);

    logger.info("CLI", "Initializing Thinking Agent v0.4.6 (Runtime Metrics + Context Checkpoints)");

    const registry = new ToolRegistry();
    [...fileTools, ...searchTools, ...shellTools, ...gitTools].forEach(tool => {
      registry.register(tool);
    });
    logger.info("CLI", `Registered ${registry.listTools().length} tools`);

    const llm = new OpenAIAdapter({ model: options.model });
    logger.info("CLI", `Model: ${options.model}`);

    const enableApproval = options.approval !== false;

    if (options.repl || !task) {
      await startREPL(llm, registry, { enableApproval, logger, options });
    } else {
      await executeTask(llm, registry, task, { enableApproval, logger, options });
    }
  });

function createAgent(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  opts: {
    enableApproval: boolean;
    options: Record<string, unknown>;
    onConfirm?: (toolCall: ToolCall, assessment: { level: RiskLevel; reason: string; risks: string[] }) => Promise<boolean>;
  }
): Agent {
  return new Agent(llm, registry, {
    maxIterations: parseInt((opts.options["maxIterations"] as string) ?? "20"),
    showThinking: (opts.options["verbose"] as boolean) ?? false,
    enableApproval: opts.enableApproval,
    onConfirm: opts.onConfirm,
  });
}

function askUserVia(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const originalPrompt = rl.getPrompt();
    rl.question(question, (answer) => {
      rl.setPrompt(originalPrompt);
      resolve(answer.trim());
    });
  });
}

function printConfirmation(toolCall: ToolCall, assessment: { level: RiskLevel; reason: string; risks: string[] }) {
  console.log("\n" + "=".repeat(60));
  console.log("⚠️  OPERATION REQUIRES CONFIRMATION");
  console.log("=".repeat(60));
  console.log(`Tool:    ${toolCall.name}`);
  console.log(`Command: ${JSON.stringify(toolCall.arguments)}`);
  console.log(`Risk:    ${assessment.level}`);
  console.log(`Reason:  ${assessment.reason}`);
  if (assessment.risks.length > 0) {
    console.log(`Risks:`);
    assessment.risks.forEach(r => console.log(`  - ${r}`));
  }
  console.log("=".repeat(60));
}

async function executeTask(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  task: string,
  opts: { enableApproval: boolean; logger: ReturnType<typeof initLogger>; options: Record<string, unknown> }
): Promise<void> {
  opts.logger.info("CLI", `Task: ${task}`);
  console.log("\n🤔 Thinking...\n");

  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] }
  ): Promise<boolean> => {
    printConfirmation(toolCall, assessment);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Allow? (y/n): ", (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  };

  const agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    onConfirm,
  });

  try {
    const result = await agent.run(task);
    console.log("\n📝 Result:\n");
    console.log(result);
    printRunMetrics(agent);
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function startREPL(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  opts: { enableApproval: boolean; logger: ReturnType<typeof initLogger>; options: Record<string, unknown> }
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "You> ",
  });

  let isConfirming = false;

  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] }
  ): Promise<boolean> => {
    isConfirming = true;
    printConfirmation(toolCall, assessment);
    const answer = await askUserVia(rl, "Allow? (y/n): ");
    isConfirming = false;
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  };

  const agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    onConfirm,
  });

  console.log("\n🤖 Thinking Agent REPL v0.4.6");
  console.log("Commands: 'exit' | 'reset' | 'state' | 'exec' | 'wm' | 'ctx' | 'metrics' | 'ctxdiff' | 'audit' | 'stats'\n");

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (isConfirming) return;
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "exit" || input === "quit") {
      console.log("Bye! 👋");
      opts.logger.close();
      process.exit(0);
    }

    if (input === "reset") {
      agent.reset();
      console.log("🔄 History cleared.\n");
      rl.prompt();
      return;
    }

    if (input === "state") {
      const state = agent.getState();
      console.log("\n📊 Agent State:");
      console.log(`  Steps: ${state.currentStep}`);
      console.log(`  Total Tokens: ${state.totalTokens}`);
      console.log(`  Tool Calls: ${state.toolCallHistory.length}`);
      console.log();
      rl.prompt();
      return;
    }

    if (input === "exec") {
      const snapshot = agent.getStateMachine().snapshot();
      console.log("\n⚙️  Execution Engine:");
      console.log(`  Status: ${snapshot.status}`);
      console.log(`  Goal: ${snapshot.currentGoal || "(none)"}`);
      console.log(`  Total Steps: ${snapshot.totalSteps}`);
      console.log(`  Completed: ${snapshot.completedSteps.length}`);
      console.log(`  Failed: ${snapshot.failedSteps.length}`);
      console.log(`  Retry Count: ${snapshot.retryCount}`);
      console.log(`  Tokens Used: ${snapshot.budgetUsed.tokens}`);
      if (snapshot.reflections.length > 0) {
        console.log(`  Reflections: ${snapshot.reflections.length}`);
        snapshot.reflections.forEach((r, i) => {
          console.log(`    ${i + 1}. [${r.trigger}] ${r.diagnosis} → ${r.newStrategy}`);
        });
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "wm") {
      const wm = agent.getWorkingMemory().snapshot();
      console.log("\n🧠 Working Memory:");
      console.log(`  Version: ${wm.version}`);
      console.log(`  Goal: ${wm.currentGoal || "(none)"}`);
      console.log(`  Step: ${wm.currentStep}`);
      if (wm.activeFiles.length > 0) console.log(`  Active Files: ${wm.activeFiles.join(", ")}`);
      if (wm.findings.length > 0) {
        console.log(`  Findings (${wm.findings.length}):`);
        wm.findings
          .slice()
          .sort((a, b) => b.strength - a.strength || b.confidence - a.confidence)
          .slice(-8)
          .reverse()
          .forEach(f => {
            const src = f.source.toolName ?? f.source.kind;
            console.log(`    [${f.importance}|str=${f.strength}|conf=${f.confidence.toFixed(2)}|src=${src}|step=${f.lastSeenStep}] ${f.content.slice(0, 90)}`);
          });
      }
      if (wm.recentErrors.length > 0) {
        console.log(`  Recent Errors:`);
        wm.recentErrors.forEach(e => console.log(`    - ${e}`));
      }
      if (wm.decisions.length > 0) {
        console.log(`  Decisions:`);
        wm.decisions.slice(-5).forEach(d => console.log(`    - ${d}`));
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "ctx") {
      const assembled = agent.getContextAssembler().assemble(
        agent.getState().messages,
        agent.getWorkingMemory(),
        agent.getStateMachine(),
        agent.getState().currentStep
      );
      const r = assembled.report;
      console.log("\n📐 Context Assembly Report:");
      console.log(`  Context Version: ${r.contextVersion}`);
      console.log(`  Memory Version: ${r.memoryVersion}`);
      console.log(`  Step: ${r.step}`);
      console.log(`  Checkpoint Created: ${r.checkpointCreated}`);
      console.log(`  Total Messages: ${r.totalMessages}`);
      console.log(`  Estimated Tokens: ${r.estimatedTotalTokens}`);
      console.log(`  Max Allowed Tokens: ${r.maxAllowedTokens}`);
      console.log(`  Compressed Messages: ${r.compressedMessages}`);
      console.log(`  Dropped For Budget: ${r.droppedForBudget}`);
      console.log(`  Injected Memory: ${r.injectedMemory}`);
      console.log(`  Injected State: ${r.injectedState}`);
      if (r.sections.length > 0) {
        console.log(`  Sections:`);
        r.sections.forEach(s => {
          console.log(`    - ${s.name}: msgs=${s.messageCount}, tokens=${s.estimatedTokens}${s.note ? `, ${s.note}` : ""}`);
        });
      }
      if (r.changedBecause.length > 0) {
        console.log(`  Changed Because:`);
        r.changedBecause.forEach(w => console.log(`    - ${w}`));
      }
      if (r.warnings.length > 0) {
        console.log(`  Warnings:`);
        r.warnings.forEach(w => console.log(`    - ${w}`));
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "metrics") {
      printRunMetrics(agent);
      console.log();
      rl.prompt();
      return;
    }

    if (input === "ctxdiff") {
      const changelog = agent.getContextAssembler().getContextChangelog();
      const entries = changelog.list();
      if (entries.length < 2) {
        console.log("\n📐 Context Diff: not enough versions yet");
      } else {
        const from = entries[entries.length - 2];
        const to = entries[entries.length - 1];
        const diff = changelog.diffVersions(from.contextVersion, to.contextVersion);
        console.log("\n📐 Context Diff (last two versions):");
        console.log(`  From Version: ${from.contextVersion} (step=${from.step})`);
        console.log(`  To Version:   ${to.contextVersion} (step=${to.step})`);
        console.log(`  Token Delta: ${diff.tokenDelta ?? 0}`);
        console.log(`  Compressed Delta: ${diff.compressedDelta ?? 0}`);
        console.log(`  Dropped Delta: ${diff.droppedDelta ?? 0}`);
        console.log(`  Memory Delta: ${diff.memoryDelta ?? 0}`);
        if ((diff.changedBecause ?? []).length > 0) {
          console.log(`  Changed Because:`);
          (diff.changedBecause ?? []).forEach(w => console.log(`    - ${w}`));
        }
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "audit") {
      const log = agent.getGateway().getAuditLog();
      console.log("\n📋 Audit Log:");
      if (log.length === 0) {
        console.log("  (no operations recorded yet)");
      } else {
        log.slice(-10).forEach(entry => {
          const icon = entry.result === "denied" ? "🚫" : entry.result === "executed" ? "✅" : "⏳";
          console.log(`  ${icon} [${entry.riskLevel}] ${entry.toolCall.name} → ${entry.result || "pending"}`);
          if (entry.risks.length > 0) {
            entry.risks.forEach(r => console.log(`     ⚠️  ${r}`));
          }
        });
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "stats") {
      const stats = agent.getGateway().getStats();
      console.log("\n📊 Risk Statistics:");
      console.log(`  Total operations: ${stats.total}`);
      console.log(`  By risk level:`);
      Object.entries(stats.byLevel).forEach(([level, count]) => {
        if (count > 0) console.log(`    ${level}: ${count}`);
      });
      console.log(`  By result:`);
      Object.entries(stats.byResult).forEach(([result, count]) => {
        if (count > 0) console.log(`    ${result}: ${count}`);
      });
      console.log();
      rl.prompt();
      return;
    }

    try {
      console.log("\n🤔 Thinking...\n");
      const result = await agent.run(input);
      console.log("\n📝 Result:\n");
      console.log(result);
      printRunMetrics(agent);
      console.log();
    } catch (error) {
      console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
      console.log();
    }

    rl.prompt();
  });
}

program.parse();

function printRunMetrics(agent: Agent) {
  const m = agent.getLastRunMetrics()?.currentSnapshot();
  if (!m) return;
  console.log("\n📊 Run Metrics:");
  console.log(`  Run ID: ${m.runId}`);
  console.log(`  Status: ${m.finalStatus}`);
  console.log(`  Loops: ${m.loops}`);
  console.log(`  Tool Calls: ${m.toolCalls}`);
  console.log(`  Retries: ${m.retries}`);
  console.log(`  Reflections: ${m.reflections}`);
  console.log(`  Prompt Tokens: ${m.promptTokens}`);
  console.log(`  Completion Tokens: ${m.completionTokens}`);
  console.log(`  Total Tokens: ${m.totalTokens}`);
  console.log(`  Context Compressed Messages: ${m.compressions}`);
  console.log(`  Context Dropped Messages: ${m.contextDroppedMessages}`);
  console.log(`  Context Versions: ${m.contextVersions}`);
  console.log(`  WM Version Start->End: ${m.workingMemoryVersionStart} -> ${m.workingMemoryVersionEnd}`);
  if (m.durationMs != null) console.log(`  Duration: ${m.durationMs} ms`);
  const failures = Object.entries(m.failureCategories ?? {}).filter(([,v]) => (v as number) > 0);
  if (failures.length > 0) {
    console.log(`  Failure Categories:`);
    failures.forEach(([k, v]) => console.log(`    - ${k}: ${v}`));
  }
  const tools = Object.entries(m.toolUsage ?? {}).sort((a,b) => (b[1] as number) - (a[1] as number)).slice(0,8);
  if (tools.length > 0) {
    console.log(`  Top Tools:`);
    tools.forEach(([k, v]) => console.log(`    - ${k}: ${v}`));
  }
}
