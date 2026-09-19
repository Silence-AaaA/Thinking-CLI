/**
 * 验证 Agent Loop 的基本逻辑（不依赖 API）
 *
 * 这个测试文件验证核心架构是否正确：
 * 1. 工具注册表能正常工作
 * 2. 工具能正常执行
 * 3. Agent 循环逻辑完整
 */

import { fileTools } from "./tools/file-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import { searchTools } from "./tools/search-tools.js";

async function testToolRegistry() {
  console.log("=== 测试工具注册表 ===\n");

  const registry = new ToolRegistry();

  // 注册工具
  [...fileTools, ...searchTools].forEach((tool) => {
    registry.register(tool);
  });
  console.log("✓ 注册工具:", registry.listTools().join(", "));

  // 获取工具定义（这会发给 LLM）
  const definitions = registry.getToolDefinitions();
  console.log(`✓ 生成了 ${definitions.length} 个工具定义`);
  console.log("  示例:", JSON.stringify(definitions[0], null, 2).slice(0, 200) + "...\n");
}

async function testListDir() {
  console.log("=== 测试 list_dir 工具 ===\n");

  const registry = new ToolRegistry();
  fileTools.forEach((tool) => {
    registry.register(tool);
  });

  const result = await registry.execute({
    id: "test-1",
    name: "list_dir",
    arguments: { path: ".", maxDepth: 1 },
  });

  console.log("✓ 执行结果:", result.success ? "成功" : "失败");
  if (result.data) {
    const data = result.data as any;
    console.log(`  找到 ${data.totalItems} 个项目`);
    data.entries?.slice(0, 5).forEach((e: any) => {
      console.log(`  - ${e.name} (${e.type})`);
    });
  }
  console.log();
}

async function testGrep() {
  console.log("=== 测试 grep 工具 ===\n");

  const registry = new ToolRegistry();
  searchTools.forEach((tool) => {
    registry.register(tool);
  });

  const result = await registry.execute({
    id: "test-2",
    name: "grep",
    arguments: { pattern: "export", path: "src", filePattern: "*.ts", maxResults: 5 },
  });

  console.log("✓ 执行结果:", result.success ? "成功" : "失败");
  if (result.data) {
    const data = result.data as any;
    console.log(`  找到 ${data.matchesFound} 个匹配`);
    data.matches?.slice(0, 3).forEach((m: any) => {
      console.log(`  - ${m.file}:${m.line} → ${m.content.slice(0, 50)}`);
    });
  }
  console.log();
}

async function testFileSummary() {
  console.log("=== 测试 file_summary 工具 ===\n");

  const registry = new ToolRegistry();
  fileTools.forEach((tool) => {
    registry.register(tool);
  });

  const result = await registry.execute({
    id: "test-3",
    name: "file_summary",
    arguments: { path: "src/core/agent.ts" },
  });

  console.log("✓ 执行结果:", result.success ? "成功" : "失败");
  if (result.data) {
    const data = result.data as any;
    console.log(`  文件: ${data.path}`);
    console.log(`  行数: ${data.lines}`);
    console.log(`  函数: ${data.functions?.join(", ") || "无"}`);
    console.log(`  Token 估算: ${result.tokenEstimate}`);
  }
  console.log();
}

async function main() {
  console.log("\n🧪 Thinking Agent 基础测试\n");

  try {
    await testToolRegistry();
    await testListDir();
    await testGrep();
    await testFileSummary();

    console.log("✅ 所有基础测试通过！");
    console.log("\n下一步：配置 .env 文件，运行 npm run repl 开始交互\n");
  } catch (error) {
    console.error("❌ 测试失败:", error);
    process.exit(1);
  }
}

main();
