/**
 * Thinking-CLI UI 工具模块
 * 
 * 提供统一的视觉风格：渐变色、ASCII Art、美化框、样式化输出
 */

import chalk from "chalk";
import gradient from "gradient-string";
import boxen from "boxen";
import figlet from "figlet";

// ─── 色彩主题 ───────────────────────────────────────────────

export const theme = {
  primary: chalk.cyan,
  secondary: chalk.magenta,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,
  muted: chalk.gray,
  bold: chalk.bold,
  dim: chalk.dim,
  white: chalk.white,
  accent: chalk.hex("#ff6b9d"),
  cyan: chalk.cyan,
  magenta: chalk.magenta,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
  gray: chalk.gray,
};

// ─── 渐变色 ─────────────────────────────────────────────────

export const gradients: Record<string, (str: string) => string> = {
  primary: gradient(["#00f5ff", "#a855f7", "#ff00e5"]),
  fire: gradient(["#ff8c00", "#ff0080"]),
  ocean: gradient(["#667eea", "#764ba2"]),
  neon: gradient(["#00ff87", "#60efff"]),
  sunset: gradient(["#fa709a", "#fee140"]),
  cool: gradient(["#2193b0", "#6dd5ed"]),
  aurora: gradient(["#00c6ff", "#0072ff", "#7209b7"]),
};

// ─── ASCII Art Banner ───────────────────────────────────────

export function generateBanner(): string {
  const ascii = figlet.textSync("Thinking", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted",
  });

  const colored = gradients.aurora(ascii);

  const subtitle = theme.muted("  ⚡ AI-Powered Coding Agent  ");
  const version = theme.dim("  v0.4.6");
  const sep = theme.muted("  " + "─".repeat(46));

  return [
    "",
    colored,
    sep,
    subtitle,
    version,
    sep,
    "",
  ].join("\n");
}

// ─── 启动信息面板 ──────────────────────────────────────────

export function renderWelcomeInfo(opts: {
  model: string;
  tools: number;
  approval: boolean;
  repl: boolean;
}): string {
  const lines = [
    `${theme.primary("┌─")} ${theme.bold("Session Info")}`,
    `${theme.primary("│")}`,
    `${theme.primary("│")}  ${theme.accent("◆")} Model     : ${theme.bold(opts.model)}`,
    `${theme.primary("│")}  ${theme.accent("◆")} Tools     : ${theme.success(opts.tools.toString())} registered`,
    `${theme.primary("│")}  ${theme.primary("◆")} Approval  : ${opts.approval ? theme.success("ON") : theme.warning("OFF")}`,
    `${theme.primary("│")}  ${theme.primary("◆")} Mode      : ${opts.repl ? theme.info("REPL") : theme.info("Task")}`,
    `${theme.primary("│")}`,
    `${theme.primary("└─")} ${theme.dim("Type your task to begin...")}`,
  ];
  return lines.join("\n");
}

// ─── REPL 提示符 ──────────────────────────────────────────

export function renderPrompt(): string {
  return `${theme.primary("❯")} `;
}

export function renderThinking(): string {
  return `\n${gradients.primary("  ◈ Thinking...")}\n`;
}

export function renderResult(): string {
  return `\n${theme.bold("  📝 Result:")}\n`;
}

// ─── 确认对话框 ────────────────────────────────────────────

export function renderConfirmation(toolCall: { name: string; arguments: Record<string, unknown> }, assessment: { level: string; reason: string; risks: string[] }): string {
  const lines: string[] = [];
  
  lines.push(`${theme.warning("  ⚠️  OPERATION REQUIRES CONFIRMATION")}`);
  lines.push(`${theme.muted("  " + "─".repeat(50))}`);
  lines.push(`  ${theme.bold("Tool")}    : ${theme.accent(toolCall.name)}`);
  lines.push(`  ${theme.bold("Command")} : ${theme.dim(JSON.stringify(toolCall.arguments).slice(0, 80))}`);
  lines.push(`  ${theme.bold("Risk")}    : ${renderRiskLevel(assessment.level)}`);
  lines.push(`  ${theme.bold("Reason")}  : ${assessment.reason}`);
  
  if (assessment.risks.length > 0) {
    lines.push(`  ${theme.bold("Risks")}:`);
    assessment.risks.forEach(r => {
      lines.push(`    ${theme.warning("⚠")} ${r}`);
    });
  }
  
  lines.push(`${theme.muted("  " + "─".repeat(50))}`);
  lines.push(`  ${theme.bold("Allow?")} ${theme.primary("[y]")}es / ${theme.error("[n]")}o`);
  
  return lines.join("\n");
}

export function renderRiskLevel(level: string): string {
  switch (level) {
    case "DESTRUCTIVE": return theme.red(`🔴 ${level}`);
    case "BLOCKED": return theme.red(`🚫 ${level}`);
    case "EXECUTE": return theme.yellow(`🟡 ${level}`);
    case "WRITE": return theme.cyan(`🔵 ${level}`);
    case "READ": return theme.green(`🟢 ${level}`);
    default: return theme.muted(level);
  }
}

// ─── Metrics 展示 ──────────────────────────────────────────

export function renderMetrics(m: {
  runId: string;
  finalStatus: string;
  loops: number;
  toolCalls: number;
  retries: number;
  reflections: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  compressions: number;
  durationMs?: number;
}): string {
  const lines: string[] = [];
  
  lines.push(``);
  lines.push(`${gradients.aurora("  ◈ Run Metrics")}`);
  lines.push(`${theme.muted("  " + "─".repeat(40))}`);
  lines.push(`  ${theme.primary("◆")} Run ID      : ${theme.dim(m.runId)}`);
  lines.push(`  ${theme.primary("◆")} Status      : ${renderStatus(m.finalStatus)}`);
  lines.push(`  ${theme.primary("◆")} Loops       : ${theme.bold(m.loops.toString())}`);
  lines.push(`  ${theme.primary("◆")} Tool Calls  : ${theme.bold(m.toolCalls.toString())}`);
  lines.push(`  ${theme.primary("◆")} Retries     : ${m.retries > 0 ? theme.yellow(m.retries.toString()) : theme.success("0")}`);
  lines.push(`  ${theme.primary("◆")} Reflections : ${theme.bold(m.reflections.toString())}`);
  lines.push(`  ${theme.primary("◆")} Tokens      : ${theme.cyan(m.totalTokens.toLocaleString())} ${theme.dim(`(${m.promptTokens} in / ${m.completionTokens} out)`)}`);
  if (m.compressions > 0) {
    lines.push(`  ${theme.primary("◆")} Compressed  : ${theme.yellow(m.compressions.toString())} messages`);
  }
  if (m.durationMs != null) {
    lines.push(`  ${theme.primary("◆")} Duration    : ${theme.bold((m.durationMs / 1000).toFixed(1))}s`);
  }
  lines.push(`${theme.muted("  " + "─".repeat(40))}`);
  
  return lines.join("\n");
}

function renderStatus(status: string): string {
  switch (status) {
    case "completed": return theme.success(`✅ ${status}`);
    case "failed": return theme.error(`❌ ${status}`);
    case "running": return theme.primary(`⏳ ${status}`);
    default: return theme.muted(status);
  }
}

// ─── 错误展示 ──────────────────────────────────────────────

export function renderError(message: string): string {
  return `\n  ${theme.error("❌")} ${theme.error(message)}\n`;
}

// ─── 分隔线 ────────────────────────────────────────────────

export function separator(char = "─", length = 50): string {
  return theme.muted(char.repeat(length));
}

// ─── Box 包装 ──────────────────────────────────────────────

export function boxed(content: string, opts?: { title?: string; padding?: number }): string {
  return boxen(content, {
    padding: opts?.padding ?? 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "cyan",
    title: opts?.title,
    titleAlignment: "center",
  });
}
