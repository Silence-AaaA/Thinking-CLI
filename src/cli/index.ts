#!/usr/bin/env node

/**
 * Thinking Agent - CLI 入口
 * 
 * Phase 3 (审批): --no-approval 模式 / audit / stats
 * Phase 3 (执行): exec 命令查看执行引擎状态
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
  .version("0.3.1");

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
    
    logger.info("CLI", "Initializing Thinking Agent v0.3.1");

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

/**
 * 创建 Agent 实例
 */
function createAgent(
  llm: OpenAIAdapter,
  registry: ToolRegistry,
  opts: { enableApproval: boolean; options: Record<string, unknown>; onConfirm?: (toolCall: ToolCall, assessment: { level: RiskLevel; reason: string; risks: string[] }) => Promise<boolean> }
): Agent {
  return new Agent(llm, registry, {
    maxIterations: parseInt(opts.options["maxIterations"] as string ?? "20"),
    showThinking: opts.options["verbose"] as boolean ?? false,
    enableApproval: opts.enableApproval,
    onConfirm: opts.onConfirm,
  });
}

/**
 * 【修复】用指定的 rl 做确认输入，不再创建新的 readline
 * 
 * 核心技巧：暂停 REPL 的 line 监听器，等确认完成后再恢复。
 * 这样 "y" 不会被 REPL 捕获。
 */
function askUserVia(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // 暂停 rl 的自动 prompt 和 line 事件处理
    const originalPrompt = rl.getPrompt();
    
    rl.question(question, (answer) => {
      // 恢复 REPL 的 prompt
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
  console.log("\n🤔 Thinking...\n");

  // 单次任务模式下用简单的 stdin 确认
  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] }
  ): Promise<boolean> => {
    printConfirmation(toolCall, assessment);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Allow? (y/n): ", (a) => { rl.close(); resolve(a.trim()); });
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
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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

  // 【修复核心】审批确认复用同一个 rl
  let isConfirming = false;
  
  const onConfirm = async (
    toolCall: ToolCall,
    assessment: { level: RiskLevel; reason: string; risks: string[] }
  ): Promise<boolean> => {
    isConfirming = true;
    printConfirmation(toolCall, assessment);
    
    // 直接用 REPL 的 rl 做确认输入
    const answer = await askUserVia(rl, "Allow? (y/n): ");
    
    isConfirming = false;
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  };

  const agent = createAgent(llm, registry, {
    enableApproval: opts.enableApproval,
    options: opts.options,
    onConfirm,
  });

  console.log("\n🤖 Thinking Agent REPL v0.3.1");
  console.log("Commands: 'exit' | 'reset' | 'state' | 'exec' | 'wm' | 'ctx' | 'audit' | 'stats'\n");

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();

    // 【修复】如果正在确认审批，忽略这行输入
    if (isConfirming) {
      return;
    }

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
      console.log();
    } catch (error) {
      console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
      console.log();
    }

    rl.prompt();
  });
}

program.parse();

