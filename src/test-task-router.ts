/**
 * Task Router 测试
 *
 * 测试 TaskRouter 的路由判断功能
 */

import { TaskRouter } from "./core/task-router.js";
import { WorkingMemory } from "./core/working-memory.js";
import type { LLMAdapter, LLMResponse, Message } from "./llm/types.js";

// ---- Mock LLM ----

function createMockLLM(response: string): LLMAdapter {
  return {
    async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
      return {
        content: response,
        toolCalls: [],
        usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
      };
    },
  };
}

// ---- Tests ----

async function testDirectRoute() {
  console.log("=== Test: TaskRouter - DIRECT route ===\n");

  const mockResponse = JSON.stringify({
    execution_mode: "DIRECT",
    reason: "This is a simple explanation task that can be completed in one execution",
  });

  const llm = createMockLLM(mockResponse);
  const router = new TaskRouter(llm);
  const memory = new WorkingMemory();

  memory.setGoal("Explain working-memory.ts");

  const route = await router.route("Explain working-memory.ts", memory);

  console.log(`Goal: Explain working-memory.ts`);
  console.log(`Route: ${route}`);
  console.log();

  console.assert(route === "direct", `Expected "direct", got "${route}"`);
  console.log("✅ DIRECT route test passed\n");
}

async function testPlanRoute() {
  console.log("=== Test: TaskRouter - PLAN route ===\n");

  const mockResponse = JSON.stringify({
    execution_mode: "PLAN",
    reason: "This task requires analysis, implementation, and verification stages",
  });

  const llm = createMockLLM(mockResponse);
  const router = new TaskRouter(llm);
  const memory = new WorkingMemory();

  memory.setGoal("Add unit tests for working-memory");

  const route = await router.route("Add unit tests for working-memory", memory);

  console.log(`Goal: Add unit tests for working-memory`);
  console.log(`Route: ${route}`);
  console.log();

  console.assert(route === "planner", `Expected "planner", got "${route}"`);
  console.log("✅ PLAN route test passed\n");
}

async function testForcePlan() {
  console.log("=== Test: TaskRouter - Force Plan ===\n");

  // This would normally return DIRECT, but forcePlan should override
  const mockResponse = JSON.stringify({
    execution_mode: "DIRECT",
    reason: "Simple task",
  });

  const llm = createMockLLM(mockResponse);
  const router = new TaskRouter(llm, { forcePlan: true });
  const memory = new WorkingMemory();

  memory.setGoal("Explain working-memory.ts");

  const route = await router.route("Explain working-memory.ts", memory);

  console.log(`Goal: Explain working-memory.ts`);
  console.log(`Route: ${route} (forced)`);
  console.log();

  console.assert(route === "planner", `Expected "planner" (forced), got "${route}"`);
  console.log("✅ Force plan test passed\n");
}

async function testParseFailure() {
  console.log("=== Test: TaskRouter - Parse Failure ===\n");

  // Invalid JSON response
  const mockResponse = "This is not valid JSON";

  const llm = createMockLLM(mockResponse);
  const router = new TaskRouter(llm);
  const memory = new WorkingMemory();

  memory.setGoal("Some task");

  const route = await router.route("Some task", memory);

  console.log(`Goal: Some task`);
  console.log(`Route: ${route} (default on parse failure)`);
  console.log();

  console.assert(route === "planner", `Expected "planner" (default), got "${route}"`);
  console.log("✅ Parse failure test passed\n");
}

// ---- Main ----

async function main() {
  console.log("🚀 Task Router Tests\n");

  try {
    await testDirectRoute();
    await testPlanRoute();
    await testForcePlan();
    await testParseFailure();

    console.log("=".repeat(60));
    console.log("✅ All Task Router tests passed!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
