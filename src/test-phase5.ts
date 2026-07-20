/**
 * Phase 5 测试 — Planning System (重构版)
 *
 * 测试四阶段规划流程：
 * 1. Goal Analysis
 * 2. Dependency Discovery
 * 3. Task Decomposition (递归)
 * 4. Execution Plan (展平)
 */

import { TaskPlanner, type TaskPlan, type TaskStep, type GoalAnalysis, type TaskNode } from "./core/task-planner.js";
import { StepExecutor } from "./core/step-executor.js";
import { WorkingMemory } from "./core/working-memory.js";
import type { LLMAdapter, LLMResponse, Message } from "./llm/types.js";

// ---- Mock LLM ----

function createMockLLM(responses: string[]): LLMAdapter {
  let callIndex = 0;
  return {
    async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
      const content = responses[callIndex] ?? responses[responses.length - 1] ?? "{}";
      callIndex++;
      return {
        content,
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  };
}

// ---- Helpers ----

function createDefaultGoalAnalysis(): GoalAnalysis {
  return {
    target: "src/core/working-memory.ts",
    action: "Add unit tests",
    deliverable: "test file with comprehensive tests",
    unknowns: ["test framework", "exported functions"],
    requiredInfo: ["module structure", "existing tests"],
  };
}

function createDefaultTaskTree(goal: string, steps: TaskStep[]): TaskNode {
  return {
    id: "1",
    title: goal,
    description: goal,
    children: steps.map((s, i) => ({
      id: String(i + 1),
      title: s.description,
      description: s.description,
      children: [],
      isAtomic: true,
      status: "pending" as const,
      dependencies: s.dependencies.map(d => String(d)),
      retryCount: 0,
    })),
    isAtomic: false,
    status: "pending",
    dependencies: [],
    retryCount: 0,
  };
}

function createTaskPlan(goal: string, steps: TaskStep[]): TaskPlan {
  return {
    goal,
    goalAnalysis: createDefaultGoalAnalysis(),
    taskTree: createDefaultTaskTree(goal, steps),
    steps,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
}

// ---- Tests ----

async function testTaskPlanner() {
  console.log("=== Test: TaskPlanner.plan() (Four-Phase) ===\n");

  // Phase 1: Goal Analysis response
  const goalAnalysisResponse = JSON.stringify({
    target: "src/core/working-memory.ts",
    action: "Add unit tests",
    deliverable: "test file with comprehensive tests",
    unknowns: ["test framework used", "existing test patterns"],
    requiredInfo: ["exported functions", "existing test examples"],
  });

  // Phase 2: Dependency Discovery response
  const dependencyResponse = JSON.stringify({
    fileDependencies: ["src/core/working-memory.ts"],
    knowledgeDependencies: ["vitest framework", "existing test patterns"],
    toolDependencies: ["npm test"],
  });

  // Phase 3: Task Decomposition response (for root task)
  const decompositionResponse = JSON.stringify({
    isAtomic: false,
    subtasks: [
      { title: "Read API", description: "Read the working-memory.ts file to understand the API", dependencies: [] },
      { title: "Create test file", description: "Create test file with vitest", dependencies: ["Read API"] },
      { title: "Write tests", description: "Write tests for snapshot() and loadSnapshot()", dependencies: ["Create test file"] },
      { title: "Run tests", description: "Run tests and verify all pass", dependencies: ["Write tests"] },
    ],
  });

  // Subtask decomposition responses (all atomic)
  const atomicResponse = JSON.stringify({ isAtomic: true, subtasks: [] });

  const llm = createMockLLM([
    goalAnalysisResponse,
    dependencyResponse,
    decompositionResponse,
    atomicResponse, // Read API
    atomicResponse, // Create test file
    atomicResponse, // Write tests
    atomicResponse, // Run tests
  ]);
  const planner = new TaskPlanner(llm);
  const memory = new WorkingMemory();

  memory.setGoal("Add unit tests for working-memory");
  memory.addFinding({
    content: "WorkingMemory has 12 public methods",
    source: { kind: "tool", toolName: "grep" },
    importance: "high",
    confidence: 0.9,
    strength: 15,
  });
  memory.addActiveFile("src/core/working-memory.ts");

  const plan = await planner.plan("Add unit tests for working-memory", memory);

  console.log(`Goal: ${plan.goal}`);
  console.log(`Goal Analysis:`);
  console.log(`  Target: ${plan.goalAnalysis.target}`);
  console.log(`  Action: ${plan.goalAnalysis.action}`);
  console.log(`  Deliverable: ${plan.goalAnalysis.deliverable}`);
  console.log(`Steps: ${plan.steps.length}`);
  plan.steps.forEach((s) => {
    console.log(`  Step ${s.id}: ${s.description} [deps: ${s.dependencies.join(",") || "none"}]`);
  });
  console.log(`Version: ${plan.version}`);
  console.log();

  // 验证
  console.assert(plan.steps.length === 4, `Expected 4 steps, got ${plan.steps.length}`);
  console.assert(plan.goalAnalysis.target === "src/core/working-memory.ts", "Goal analysis target should be correct");
  console.assert(plan.steps[0].dependencies.length === 0, "Step 1 should have no deps");
  console.assert(plan.steps[1].dependencies.includes(1), "Step 2 should depend on step 1");
  console.assert(plan.steps[0].status === "pending", "All steps should be pending");
  console.log("✅ TaskPlanner.plan() passed\n");
}

async function testStepExecutor() {
  console.log("=== Test: StepExecutor.executeWithReset() ===\n");

  const plan = createTaskPlan("Test goal", [
    { id: 1, description: "Step one", status: "pending", dependencies: [], retryCount: 0 },
    { id: 2, description: "Step two", status: "pending", dependencies: [1], retryCount: 0 },
    { id: 3, description: "Step three", status: "pending", dependencies: [2], retryCount: 0 },
  ]);

  // Mock Agent with run() that always succeeds
  const mockAgent = {
    async run(goal: string): Promise<string> {
      return `Completed: ${goal.slice(0, 30)}`;
    },
    resetForStep() {},
    setMaxIterations() {},
    getWorkingMemory() {
      return new WorkingMemory();
    },
  };

  const executor = new StepExecutor();
  const memory = new WorkingMemory();

  const result = await executor.executeWithReset(
    plan,
    mockAgent as unknown as Parameters<typeof executor.executeWithReset>[1],
    memory
  );

  console.log(`Status: ${result.finalStatus}`);
  console.log(`Completed: ${result.completedSteps}/${result.totalSteps}`);
  console.log(`Duration: ${result.durationMs} ms`);
  result.stepResults.forEach((r) => {
    console.log(`  Step ${r.stepId}: ${r.status} -> ${r.result.slice(0, 50)}`);
  });
  console.log();

  console.assert(result.finalStatus === "completed", "Expected completed status");
  console.assert(result.completedSteps === 3, "Expected 3 completed steps");
  console.assert(result.plan.steps.every((s) => s.status === "completed"), "All steps should be completed");
  console.log("✅ StepExecutor.executeWithReset() passed\n");
}

async function testStepFailure() {
  console.log("=== Test: Step failure + dependency skip ===\n");

  const plan = createTaskPlan("Test failure handling", [
    { id: 1, description: "Step one (will succeed)", status: "pending", dependencies: [], retryCount: 0 },
    { id: 2, description: "Step two (will fail)", status: "pending", dependencies: [1], retryCount: 0 },
    { id: 3, description: "Step three (depends on 2, should be skipped)", status: "pending", dependencies: [2], retryCount: 0 },
  ]);

  let callCount = 0;
  const mockAgent = {
    async run(goal: string): Promise<string> {
      callCount++;
      if (callCount === 2) throw new Error("Simulated failure");
      return `Done: ${goal.slice(0, 30)}`;
    },
    resetForStep() {},
    setMaxIterations() {},
  };

  const executor = new StepExecutor();
  const result = await executor.executeWithReset(
    plan,
    mockAgent as unknown as Parameters<typeof executor.executeWithReset>[1],
    new WorkingMemory()
  );

  console.log(`Status: ${result.finalStatus}`);
  console.log(`Completed: ${result.completedSteps}/${result.totalSteps}`);
  result.plan.steps.forEach((s) => {
    console.log(`  Step ${s.id}: ${s.status} ${s.result ? `-> ${s.result.slice(0, 50)}` : ""}`);
  });
  console.log();

  console.assert(result.finalStatus === "partial", "Expected partial status");
  console.assert(result.plan.steps[0].status === "completed", "Step 1 should be completed");
  console.assert(result.plan.steps[1].status === "failed", "Step 2 should be failed");
  console.assert(result.plan.steps[2].status === "skipped", "Step 3 should be skipped");
  console.assert(callCount === 2, "Should only call run() twice (step 1 + step 2, step 3 skipped)");
  console.log("✅ Step failure + dependency skip passed\n");
}

async function testReplan() {
  console.log("=== Test: TaskPlanner.replan() ===\n");

  const originalPlan = createTaskPlan("Add tests", [
    { id: 1, description: "Read API", status: "completed", dependencies: [], result: "Found 12 methods", retryCount: 0 },
    { id: 2, description: "Write tests", status: "failed", dependencies: [1], result: "vitest not installed", retryCount: 2 },
    { id: 3, description: "Run tests", status: "pending", dependencies: [2], retryCount: 0 },
  ]);

  const replanResponse = JSON.stringify([
    { id: 1, description: "Read API", dependencies: [] },
    { id: 2, description: "Install vitest", dependencies: [1] },
    { id: 3, description: "Write tests", dependencies: [2] },
    { id: 4, description: "Run tests", dependencies: [3] },
  ]);

  const llm = createMockLLM([replanResponse]);
  const planner = new TaskPlanner(llm);
  const failedStep = originalPlan.steps[1];

  const newPlan = await planner.replan(
    originalPlan,
    failedStep,
    "vitest not installed",
    new WorkingMemory()
  );

  console.log(`Original version: ${originalPlan.version}`);
  console.log(`New version: ${newPlan.version}`);
  console.log(`Steps: ${newPlan.steps.length}`);
  newPlan.steps.forEach((s) => {
    console.log(`  Step ${s.id}: ${s.description} [${s.status}]${s.result ? ` -> ${s.result}` : ""}`);
  });
  console.log();

  console.assert(newPlan.version === 2, "Version should be 2");
  console.assert(newPlan.steps[0].status === "completed", "Step 1 should still be completed");
  console.assert(newPlan.steps[0].result === "Found 12 methods", "Step 1 result should be preserved");
  console.assert(newPlan.steps.length === 4, "Should have 4 steps after replan");
  console.log("✅ TaskPlanner.replan() passed\n");
}

async function testBuildStepGoal() {
  console.log("=== Test: StepExecutor.buildStepGoal() ===\n");

  const plan = createTaskPlan("Add unit tests", [
    { id: 1, description: "Read the API", status: "completed", dependencies: [], result: "Found 12 public methods", retryCount: 0 },
    { id: 2, description: "Write test file", status: "pending", dependencies: [1], retryCount: 0 },
    { id: 3, description: "Run tests", status: "pending", dependencies: [2], retryCount: 0 },
  ]);

  const executor = new StepExecutor();
  const stepGoal = executor.buildStepGoal(plan.steps[1], plan);

  console.log(stepGoal);
  console.log();

  console.assert(stepGoal.includes("[Step 2/3]"), "Should contain step position");
  console.assert(stepGoal.includes("Write test file"), "Should contain current step description");
  console.assert(stepGoal.includes("Read the API"), "Should contain completed step");
  console.assert(stepGoal.includes("Found 12 public methods"), "Should contain step result");
  console.assert(stepGoal.includes("Completed Steps"), "Should have completed steps section");
  console.assert(stepGoal.includes("Complete this step"), "Should have instruction");
  console.log("✅ buildStepGoal() passed\n");
}

// ---- Main ----

async function main() {
  console.log("🚀 Phase 5: Planning System Tests (Four-Phase)\n");

  try {
    await testTaskPlanner();
    await testStepExecutor();
    await testStepFailure();
    await testReplan();
    await testBuildStepGoal();

    console.log("=".repeat(60));
    console.log("✅ All Phase 5 tests passed!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
