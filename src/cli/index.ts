#!/usr/bin/env node

/**
 * Thinking-CLI - 入口
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
import type { PlanExecutionResult } from "../core/step-executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { fileTools } from "../tools/file-tools.js";
import { searchTools } from "../tools/search-tools.js";
import { shellTools } from "../tools/shell-tool.js";
import { gitTools } from "../tools/git-tools.js";
import { OpenAIAdapter } from "../llm/openai-adapter.js";
import { initLogger, LogLevel } from "../utils/logger.js";
import {
  theme,
  gradients,
  generateBanner,
  renderWelcomeInfo,
  renderPrompt,
  renderThinking,
  renderResult,
  renderConfirmation,
  renderMetrics,
  renderError,
  renderRiskLevel,
} from "../utils/ui.js";
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

    const registry = new ToolRegistry();
    [...fileTools, ...searchTools, ...shellTools, ...gitTools].forEach(tool => {
      registry.register(tool);
    });

    const llm = new OpenAIAdapter({ model: options.model });
    const enableApproval = options.approval !== false;
    const isRepl = options.repl || !task;

    // ── 显示启动 Banner ──
    console.log(generateBanner());
    console.log(renderWelcomeInfo({
      model: options.model,
      tools: registry.listTools().length,
      approval: enableApproval,
      repl: isRepl,
    }));

    if (isRepl) {
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

async function executeTask(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  task: string,
  opts: { enableApproval: boolean; logger: ReturnType<typeof initLogger>; options: Record<string, unknown> }
): Promise<void> {
  opts.logger.info("CLI", `Task: ${task}`);
  console.log(renderThinking());

  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] }
  ): Promise<boolean> => {
    console.log(renderConfirmation(toolCall, { level: assessment.level as string, reason: assessment.reason, risks: assessment.risks }));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(renderPrompt(), (a) => {
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
    console.log(renderResult());
    console.log(result);
    const m = agent.getLastRunMetrics()?.currentSnapshot();
    if (m) {
      console.log(renderMetrics(m));
    }
    console.log();
  } catch (error) {
    console.log(renderError(error instanceof Error ? error.message : String(error)));
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
    prompt: renderPrompt(),
  });

  let agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    onConfirm: async (toolCall, assessment) => {
      console.log(renderConfirmation(toolCall, { level: assessment.level as string, reason: assessment.reason, risks: assessment.risks }));
      const answer = await askUserVia(rl, renderPrompt());
      return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    },
  });

  console.log(theme.dim("  Type your task, or 'help' for commands.\n"));
  rl.prompt();

  rl.on("line", async (input: string) => {
    input = input.trim();

    if (input === "" || input === "exit" || input === "quit") {
      if (input === "exit" || input === "quit") {
        console.log(`\n  ${theme.success("👋")} ${theme.muted("Goodbye!")}\n`);
        process.exit(0);
      }
      rl.prompt();
      return;
    }

    if (input === "help") {
      console.log(`
  ${gradients.aurora("◈ Commands")}
  ${theme.muted("  " + "─".repeat(40))}
  ${theme.primary("◆")} ${theme.bold("help")}         Show this help
  ${theme.primary("◆")} ${theme.bold("audit")}        View audit log
  ${theme.primary("◆")} ${theme.bold("stats")}        Risk statistics
  ${theme.primary("◆")} ${theme.bold("wm")}           Working memory
  ${theme.primary("◆")} ${theme.bold("ctx")}           Context state
  ${theme.primary("◆")} ${theme.bold("metrics")}       Runtime metrics
  ${theme.primary("◆")} ${theme.bold("ctxdiff")}       Context diff
  ${theme.primary("◆")} ${theme.bold("clear")}         Clear context
  ${theme.primary("◆")} ${theme.bold("exit")} / ${theme.bold("quit")}   Exit
  ${theme.muted("  " + "─".repeat(40))}
`);
      rl.prompt();
      return;
    }

    if (input === "audit") {
      const audit = agent.getGateway().getAuditLog();
      if (audit.length === 0) {
        console.log(`\n  ${theme.muted("No audit entries.")}\n`);
      } else {
        console.log(`\n  ${gradients.aurora("◈ Audit Log")}`);
        console.log(theme.muted("  " + "─".repeat(50)));
        audit.slice(-10).forEach((entry, i) => {
          const level = entry.riskLevel as string;
          const riskColor = level === "DESTRUCTIVE" || level === "BLOCKED" ? theme.red : level === "EXECUTE" ? theme.yellow : theme.green;
          console.log(`  ${theme.dim(`#${i + 1}`)} ${theme.bold(entry.toolCall.name)} → ${renderRiskLevel(level)} ${theme.dim(`[${entry.result || "pending"}]`)}`);
          if (entry.risks.length > 0) {
            entry.risks.forEach(r => console.log(`     ${theme.warning("⚠")} ${r}`));
          }
        });
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input === "stats") {
      const stats = agent.getGateway().getStats();
      console.log(`\n  ${gradients.aurora("◈ Risk Statistics")}`);
      console.log(theme.muted("  " + "─".repeat(40)));
      console.log(`  ${theme.primary("◆")} Total: ${theme.bold(stats.total.toString())}`);
      console.log(`  ${theme.bold("  By Level:")}`);
      Object.entries(stats.byLevel).forEach(([level, count]) => {
        if (count > 0) console.log(`    ${theme.accent(level)}: ${theme.bold(count.toString())}`);
      });
      console.log(`  ${theme.bold("  By Result:")}`);
      Object.entries(stats.byResult).forEach(([result, count]) => {
        if (count > 0) console.log(`    ${theme.accent(result)}: ${theme.bold(count.toString())}`);
      });
      console.log();
      rl.prompt();
      return;
    }


    // Handle "plan" command
    if (input.toLowerCase().startsWith("plan ")) {
      const task = input.slice(5).trim();
      if (task) {
        console.log(`\n  ${gradients.primary("◈ Planning task...")}\n`);
        try {
          const result = await agent.runPlanned(task);
          printPlanResult(result);
        } catch (error) {
          console.log(renderError(error instanceof Error ? error.message : String(error)));
        }
      } else {
        console.log(`\n  ${theme.warning("⚠")} ${theme.muted("Usage: plan <task description>")}\n`);
      }
      rl.prompt();
      return;
    }

    try {
      console.log(renderThinking());
      const result = await agent.run(input);
      console.log(renderResult());
      console.log(result);
      printRunMetrics(agent);
      console.log();
    } catch (error) {
      console.log(renderError(error instanceof Error ? error.message : String(error)));
    }

    rl.prompt();
  });
}


program
  .command("plan")
  .description("Execute a complex task with planning (decompose → execute → replan)")
  .argument("<task>", "Complex task to plan and execute")
  .option("--model <model>", "LLM model to use", process.env.OPENAI_MODEL || "gpt-4o")
  .option("--max-iterations <n>", "Max ReAct iterations per step", "20")
  .option("--verbose", "Enable verbose logging")
  .option("--no-approval", "Disable approval system")
  .action(async (task: string, options) => {
    const logLevel = options.verbose ? LogLevel.DEBUG : LogLevel.INFO;
    const logger = initLogger(logLevel);

    logger.info("CLI", `Planned task: ${task}`);
    console.log(`\n  ${gradients.primary("◈ Planning task...")}\n`);

    const registry = new ToolRegistry();
    [...fileTools, ...searchTools, ...shellTools, ...gitTools].forEach(tool => {
      registry.register(tool);
    });

    const llm = new OpenAIAdapter({ model: options.model });
    const enableApproval = options.approval !== false;

    const agent = createAgent(llm, registry, {
      enableApproval,
      options,
    });

    try {
      const result = await agent.runPlanned(task);
      printPlanResult(result);
    } catch (error) {
      console.log(renderError(error instanceof Error ? error.message : String(error)));
    }
  });

function printPlanResult(result: PlanExecutionResult) {
  console.log("");
  console.log(gradients.aurora("  ◈ Plan Execution Result"));
  console.log(theme.muted("  " + "─".repeat(50)));
  console.log(`  ${theme.primary("◆")} Goal    : ${theme.bold(result.plan.goal)}`);
  console.log(`  ${theme.primary("◆")} Status  : ${result.finalStatus === "completed" ? theme.success(result.finalStatus) : theme.error(result.finalStatus)}`);
  console.log(`  ${theme.primary("◆")} Steps   : ${theme.bold(`${result.completedSteps}/${result.totalSteps}`)} completed`);
  console.log(`  ${theme.primary("◆")} Duration: ${theme.bold((result.durationMs / 1000).toFixed(1))}s`);
  console.log(`  ${theme.primary("◆")} Version : ${theme.dim(`v${result.plan.version}`)}`);
  console.log("");
  console.log(`  ${theme.bold("Steps:")}`);
  for (const step of result.plan.steps) {
    const icon = step.status === "completed" ? theme.success("✅") : step.status === "failed" ? theme.error("❌") : step.status === "skipped" ? theme.warning("⏭️") : theme.muted("⬜");
    console.log(`    ${icon} ${theme.bold(`Step ${step.id}`)}: ${step.description}`);
    if (step.result) {
      console.log(`       ${theme.dim("→")} ${theme.dim(step.result.slice(0, 100))}${step.result.length > 100 ? theme.dim("...") : ""}`);
    }
  }
  console.log(theme.muted("  " + "─".repeat(50)));
  console.log("");
}

program.parse();

function printRunMetrics(agent: Agent) {
  const m = agent.getLastRunMetrics()?.currentSnapshot();
  if (!m) return;
  console.log(renderMetrics(m));
}




