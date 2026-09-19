#!/usr/bin/env node

/**
 * Thinking-CLI - 入口
 *
 * 配置优先级：CLI 参数 > .thinking.json > ~/.thinking/config.json > 内置默认
 */

import { Command } from "commander";
import * as dotenv from "dotenv";
import * as readline from "readline";
import { type CapabilityLevel, getCapabilityProfile } from "../capabilities.js";
import { getConfigPaths, loadConfig, saveProjectConfig } from "../config.js";
import { Agent } from "../core/agent.js";
import type { RiskLevel } from "../core/risk-assessor.js";
import type { PlanExecutionResult } from "../core/step-executor.js";
import { OpenAIAdapter } from "../llm/openai-adapter.js";
import { fileTools } from "../tools/file-tools.js";
import { gitTools } from "../tools/git-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { searchTools } from "../tools/search-tools.js";
import { shellTools } from "../tools/shell-tool.js";
import type { ToolCall } from "../tools/types.js";
import { initLogger, LogLevel } from "../utils/logger.js";
import {
  generateBanner,
  gradients,
  renderCapabilityBadge,
  renderCapabilityList,
  renderCapabilitySwitch,
  renderConfirmation,
  renderError,
  renderMetrics,
  renderPrompt,
  renderResult,
  renderRiskLevel,
  renderThinking,
  renderWelcomeInfo,
  theme,
} from "../utils/ui.js";

dotenv.config();

function assertApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      renderError(
        "Missing OPENAI_API_KEY. Copy .env.example to .env and fill in your API key (DeepSeek example included).",
      ),
    );
    process.exit(1);
  }
}

const program = new Command();

program
  .name("thinking-agent")
  .description("A CLI coding agent with ReAct loop, planning, memory and safety controls")
  .version("0.4.6");

program
  .argument("[task]", "Task to execute (omit for REPL mode)")
  .option("--repl", "Start interactive REPL mode")
  .option("--model <model>", "LLM model to use (overrides config)")
  .option("-c, --capability <level>", "Capability level: low | medium | high | max (overrides config)")
  .option("--max-iterations <n>", "Max ReAct iterations (overrides capability default)")
  .option("--verbose", "Enable verbose logging")
  .option("--log-dir <dir>", "Directory to save logs")
  .option("--no-approval", "Disable approval system (dev mode)")
  .action(async (task: string | undefined, options) => {
    // ── 加载配置文件 ──
    const config = loadConfig();

    // 合并优先级：CLI 参数 > 配置文件 > .env > 内置默认
    const capLevel = options.capability || config.defaultCapability || "medium";
    const capProfile = getCapabilityProfile(capLevel);
    const model = options.model || config.model || process.env.OPENAI_MODEL || "gpt-4o";
    const enableApproval = options.approval !== false && config.approval !== false;

    const logLevel = options.verbose ? LogLevel.DEBUG : LogLevel.INFO;
    const logger = initLogger(logLevel, options.logDir);

    const registry = new ToolRegistry();
    [...fileTools, ...searchTools, ...shellTools, ...gitTools].forEach((tool) => {
      registry.register(tool);
    });

    assertApiKey();
    const llm = new OpenAIAdapter({
      model,
      temperature: capProfile.temperature,
    });

    const isRepl = options.repl || !task;

    console.log(generateBanner());
    console.log(
      renderWelcomeInfo({
        model,
        tools: registry.listTools().length,
        approval: enableApproval,
        repl: isRepl,
        capability: capProfile.level,
      }),
    );

    if (isRepl) {
      await startREPL(llm, registry, { enableApproval, logger, options, capabilityLevel: capProfile.level });
    } else {
      await executeTask(llm, registry, task, { enableApproval, logger, options, capabilityLevel: capProfile.level });
    }
  });

function createAgent(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  opts: {
    enableApproval: boolean;
    options: Record<string, unknown>;
    capabilityLevel: string;
    onConfirm?: (
      toolCall: ToolCall,
      assessment: { level: RiskLevel; reason: string; risks: string[] },
    ) => Promise<boolean>;
  },
): Agent {
  const capProfile = getCapabilityProfile(opts.capabilityLevel);
  const explicitIterations = opts.options["maxIterations"] as string | undefined;
  const maxIterations = explicitIterations ? parseInt(explicitIterations) : capProfile.maxIterations;

  return new Agent(llm, registry, {
    maxIterations,
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
  opts: {
    enableApproval: boolean;
    logger: ReturnType<typeof initLogger>;
    options: Record<string, unknown>;
    capabilityLevel: string;
  },
): Promise<void> {
  opts.logger.info("CLI", `Task: ${task} [capability=${opts.capabilityLevel}]`);
  console.log(renderThinking());

  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] },
  ): Promise<boolean> => {
    console.log(
      renderConfirmation(toolCall, {
        level: assessment.level as string,
        reason: assessment.reason,
        risks: assessment.risks,
      }),
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(renderPrompt(opts.capabilityLevel), (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  };

  const agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    capabilityLevel: opts.capabilityLevel,
    onConfirm,
  });

  try {
    const result = await agent.runAuto(task);
    if (typeof result === "string") {
      console.log(renderResult());
      console.log(result);
      const m = agent.getLastRunMetrics()?.currentSnapshot();
      if (m) {
        console.log(renderMetrics(m));
      }
    } else {
      printPlanResult(result);
    }
    console.log();
  } catch (error) {
    console.log(renderError(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

async function startREPL(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  opts: {
    enableApproval: boolean;
    logger: ReturnType<typeof initLogger>;
    options: Record<string, unknown>;
    capabilityLevel: string;
  },
): Promise<void> {
  let currentCapLevel = opts.capabilityLevel;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: renderPrompt(currentCapLevel),
  });

  let agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    capabilityLevel: currentCapLevel,
    onConfirm: async (toolCall, assessment) => {
      console.log(
        renderConfirmation(toolCall, {
          level: assessment.level as string,
          reason: assessment.reason,
          risks: assessment.risks,
        }),
      );
      const answer = await askUserVia(rl, renderPrompt(currentCapLevel));
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

    // ── help ──
    if (input === "help") {
      console.log(`\n  ${gradients.aurora("◈ Commands")}`);
      console.log(theme.muted("  " + "─".repeat(48)));
      console.log(`  ${theme.primary("◆")} ${theme.bold("help")}           Show this help`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("cap [level]")}    View or switch capability`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("cap save")}       Save current capability as default`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("config")}         Show config file paths`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("audit")}          View audit log`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("stats")}          Risk statistics`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("plan <task>")}    Run in planning mode`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("wm")}             Working memory`);
      console.log(`  ${theme.primary("◆")} ${theme.bold("exit")} / ${theme.bold("quit")}     Exit`);
      console.log(theme.muted("  " + "─".repeat(48)));
      console.log();
      rl.prompt();
      return;
    }

    // ── config ──
    if (input === "config") {
      const paths = getConfigPaths();
      console.log(`\n  ${gradients.aurora("◈ Config")}`);
      console.log(theme.muted("  " + "─".repeat(48)));
      console.log(`  ${theme.primary("◆")} Current capability: ${renderCapabilityBadge(currentCapLevel)}`);
      console.log(
        `  ${theme.primary("◆")} Project config: ${paths.project ? theme.success(paths.project) : theme.muted("not found")}`,
      );
      console.log(`  ${theme.primary("◆")} User config:    ${theme.dim(paths.user)}`);
      console.log(theme.muted("  " + "─".repeat(48)));
      console.log();
      rl.prompt();
      return;
    }

    // ── cap (查看) ──
    if (input === "cap" || input === "capability") {
      console.log(renderCapabilityList());
      rl.prompt();
      return;
    }

    // ── cap save ──
    if (input === "cap save" || input === "capability save") {
      try {
        saveProjectConfig({ defaultCapability: currentCapLevel as CapabilityLevel });
        console.log(
          `\n  ${theme.success("✅")} Saved ${renderCapabilityBadge(currentCapLevel)} as default to ${theme.dim(".thinking.json")}\n`,
        );
      } catch (e) {
        console.log(renderError(`Failed to save config: ${e}`));
      }
      rl.prompt();
      return;
    }

    // ── cap <level> ──
    if (input.startsWith("cap ") || input.startsWith("capability ")) {
      const newLevel = input.split(/\s+/)[1]?.toLowerCase() ?? "";
      if (["low", "medium", "high", "max"].includes(newLevel)) {
        const oldLevel = currentCapLevel;
        currentCapLevel = newLevel;
        const profile = getCapabilityProfile(newLevel);

        agent = createAgent(llm, registry, {
          enableApproval: opts.enableApproval,
          options: opts.options,
          capabilityLevel: currentCapLevel,
          onConfirm: async (toolCall, assessment) => {
            console.log(
              renderConfirmation(toolCall, {
                level: assessment.level as string,
                reason: assessment.reason,
                risks: assessment.risks,
              }),
            );
            const answer = await askUserVia(rl, renderPrompt(currentCapLevel));
            return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
          },
        });

        rl.setPrompt(renderPrompt(currentCapLevel));
        console.log(renderCapabilitySwitch(oldLevel, newLevel, profile.temperature, profile.maxIterations));
        console.log(theme.dim(`  Tip: type 'cap save' to make this your default\n`));
      } else {
        console.log(`\n  ${theme.error("❌")} Unknown level: ${theme.bold(newLevel)}`);
        console.log(renderCapabilityList());
      }
      rl.prompt();
      return;
    }

    // ── audit ──
    if (input === "audit") {
      const audit = agent.getGateway().getAuditLog();
      if (audit.length === 0) {
        console.log(`\n  ${theme.muted("No audit entries.")}\n`);
      } else {
        console.log(`\n  ${gradients.aurora("◈ Audit Log")}`);
        console.log(theme.muted("  " + "─".repeat(50)));
        audit.slice(-10).forEach((entry, i) => {
          const level = entry.riskLevel as string;
          console.log(
            `  ${theme.dim(`#${i + 1}`)} ${theme.bold(entry.toolCall.name)} → ${renderRiskLevel(level)} ${theme.dim(`[${entry.result || "pending"}]`)}`,
          );
          if (entry.risks.length > 0) {
            entry.risks.forEach((r) => {
              console.log(`     ${theme.warning("⚠")} ${r}`);
            });
          }
        });
      }
      console.log();
      rl.prompt();
      return;
    }

    // ── stats ──
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

    // ── plan ──
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

    // ── normal task ──
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
  .option("--model <model>", "LLM model to use")
  .option("-c, --capability <level>", "Capability level: low | medium | high | max", "high")
  .option("--max-iterations <n>", "Max ReAct iterations per step", "20")
  .option("--verbose", "Enable verbose logging")
  .option("--no-approval", "Disable approval system")
  .action(async (task: string, options) => {
    const config = loadConfig();
    const capLevel = options.capability || config.defaultCapability || "high";
    const capProfile = getCapabilityProfile(capLevel);
    const model = options.model || config.model || process.env.OPENAI_MODEL || "gpt-4o";

    const logLevel = options.verbose ? LogLevel.DEBUG : LogLevel.INFO;
    const logger = initLogger(logLevel);

    logger.info("CLI", `Planned task: ${task} [capability=${capProfile.level}]`);
    console.log(`\n  ${gradients.primary("◈ Planning task...")}\n`);

    const registry = new ToolRegistry();
    [...fileTools, ...searchTools, ...shellTools, ...gitTools].forEach((tool) => {
      registry.register(tool);
    });

    assertApiKey();
    const llm = new OpenAIAdapter({
      model,
      temperature: capProfile.temperature,
    });
    const enableApproval = options.approval !== false && config.approval !== false;

    const agent = createAgent(llm, registry, {
      enableApproval,
      options,
      capabilityLevel: capProfile.level,
    });

    try {
      const result = await agent.runPlanned(task);
      printPlanResult(result);
    } catch (error) {
      console.log(renderError(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

function printPlanResult(result: PlanExecutionResult) {
  console.log("");
  console.log(gradients.aurora("  ◈ Plan Execution Result"));
  console.log(theme.muted("  " + "─".repeat(50)));
  console.log(`  ${theme.primary("◆")} Goal    : ${theme.bold(result.plan.goal)}`);
  console.log(
    `  ${theme.primary("◆")} Status  : ${result.finalStatus === "completed" ? theme.success(result.finalStatus) : theme.error(result.finalStatus)}`,
  );
  console.log(
    `  ${theme.primary("◆")} Steps   : ${theme.bold(`${result.completedSteps}/${result.totalSteps}`)} completed`,
  );
  console.log(`  ${theme.primary("◆")} Duration: ${theme.bold((result.durationMs / 1000).toFixed(1))}s`);
  console.log(`  ${theme.primary("◆")} Version : ${theme.dim(`v${result.plan.version}`)}`);
  console.log("");
  console.log(`  ${theme.bold("Steps:")}`);
  for (const step of result.plan.steps) {
    const icon =
      step.status === "completed"
        ? theme.success("✅")
        : step.status === "failed"
          ? theme.error("❌")
          : step.status === "skipped"
            ? theme.warning("⏭️")
            : theme.muted("⬜");
    console.log(`    ${icon} ${theme.bold(`Step ${step.id}`)}: ${step.description}`);
    if (step.result) {
      console.log(
        `       ${theme.dim("→")} ${theme.dim(step.result.slice(0, 100))}${step.result.length > 100 ? theme.dim("...") : ""}`,
      );
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
