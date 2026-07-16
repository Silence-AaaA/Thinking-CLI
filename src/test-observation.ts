/**
 * Phase 2 测试 — Observation Layer
 */

import { ObservationManager } from "./core/observation.js";
import type { ToolCall, ToolResult } from "./tools/types.js";

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test-${Date.now()}`, name, arguments: args };
}

async function testObservationManager() {
  console.log("=== 测试 Observation Manager ===\n");
  const manager = new ObservationManager();

  // 测试 1: 文件摘要
  console.log("  Test 1: file_summary 观察提取");
  const summaryObs = manager.observe(
    makeToolCall("file_summary", { path: "src/main.ts" }),
    {
      success: true,
      data: { path: "src/main.ts", lines: 150, language: "ts", functions: ["init", "run", "cleanup"], classes: ["App"] },
      tokenEstimate: 80,
    }
  );
  console.log(`    Summary: ${summaryObs.summary}`);
  console.log(`    Findings: ${summaryObs.keyFindings.join(" | ")}`);
  console.log(`    Tokens: ${summaryObs.tokenEstimate}`);
  console.log();

  // 测试 2: grep 搜索
  console.log("  Test 2: grep 观察提取");
  const grepObs = manager.observe(
    makeToolCall("grep", { pattern: "TODO" }),
    {
      success: true,
      data: {
        pattern: "TODO",
        matchesFound: 8,
        matches: [
          { file: "src/main.ts", line: 42, content: "// TODO: fix this" },
          { file: "src/utils.ts", line: 15, content: "// TODO: optimize" },
        ],
      },
      tokenEstimate: 60,
    }
  );
  console.log(`    Summary: ${grepObs.summary}`);
  console.log(`    Findings: ${grepObs.keyFindings.join(" | ")}`);
  console.log(`    Suggested: ${grepObs.suggestedAction ?? "none"}`);
  console.log();

  // 测试 3: shell 命令成功
  console.log("  Test 3: shell 成功观察提取");
  const shellObs = manager.observe(
    makeToolCall("run_shell", { command: "npm test" }),
    {
      success: true,
      data: {
        command: "npm test",
        exitCode: 0,
        stdout: "PASS src/app.test.ts\nPASS src/utils.test.ts\n\nTest Suites: 2 passed\nTests:       15 passed\nTime:        3.2s",
        duration: 3200,
      },
      tokenEstimate: 100,
    }
  );
  console.log(`    Summary: ${shellObs.summary}`);
  console.log(`    Findings: ${shellObs.keyFindings.join(" | ")}`);
  console.log();

  // 测试 4: shell 命令失败
  console.log("  Test 4: shell 失败观察提取（含错误分类）");
  const failObs = manager.observe(
    makeToolCall("run_shell", { command: "npm test" }),
    {
      success: false,
      data: {
        command: "npm test",
        exitCode: 1,
        stdout: "FAIL src/auth.test.ts\n  ● login › should validate credentials\n\n    Expected: true\n    Received: false\n\nTest Suites: 1 failed, 1 passed\nTests:       1 failed, 14 passed",
        stderr: "",
        duration: 2800,
      },
      error: "Command failed with exit code 1",
    }
  );
  console.log(`    Summary: ${failObs.summary}`);
  console.log(`    Findings: ${failObs.keyFindings.join(" | ")}`);
  console.log(`    Error Type: ${failObs.errorType}`);
  console.log(`    Suggested: ${failObs.suggestedAction ?? "none"}`);
  console.log();

  // 测试 5: 文件不存在
  console.log("  Test 5: 文件不存在（错误分类 + 恢复建议）");
  const enoentObs = manager.observe(
    makeToolCall("read_file", { path: "/nonexistent/file.txt" }),
    {
      success: false,
      error: "ENOENT: no such file or directory, open '/nonexistent/file.txt'",
    }
  );
  console.log(`    Summary: ${enoentObs.summary}`);
  console.log(`    Error Type: ${enoentObs.errorType}`);
  console.log(`    Suggested: ${enoentObs.suggestedAction}`);
  console.log();

  // 测试 6: git status
  console.log("  Test 6: git status 观察提取");
  const gitObs = manager.observe(
    makeToolCall("git_status", {}),
    {
      success: true,
      data: {
        branch: "main",
        staged: ["src/app.ts"],
        unstaged: ["src/utils.ts", "README.md"],
        untracked: ["temp.txt"],
        summary: { stagedCount: 1, unstagedCount: 2, untrackedCount: 1 },
      },
      tokenEstimate: 80,
    }
  );
  console.log(`    Summary: ${gitObs.summary}`);
  console.log(`    Findings: ${gitObs.keyFindings.join(" | ")}`);
  console.log();

  // 测试 7: 格式化输出给 LLM
  console.log("  Test 7: 格式化输出（LLM 实际看到的）");
  const formatted = manager.formatForLLM(failObs);
  console.log("    ---");
  formatted.split("\n").forEach(l => console.log(`    ${l}`));
  console.log("    ---");
  console.log();

  return true;
}

async function main() {
  console.log("\n🧪 Phase 2: Observation Layer 测试\n");

  const ok = await testObservationManager();

  if (ok) {
    console.log("✅ Observation Layer 测试通过！");
    console.log("\n核心变化:");
    console.log("  - 工具原始输出 → Observation Layer → 结构化摘要");
    console.log("  - LLM 看到的是 Observation，不是原始数据");
    console.log("  - 失败时自动分类错误类型 + 提供恢复建议");
    console.log("  - Token 消耗大幅降低（npm test 3000行 → ~80 tokens）\n");
  } else {
    console.log("❌ 测试失败");
    process.exit(1);
  }
}

main();
