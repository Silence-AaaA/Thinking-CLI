/**
 * Phase 3 Execution Engine 测试
 *
 * 测试 State Machine + Error Taxonomy + Reflection 三大模块
 */

import { StateMachine, ExecutionStatus } from "./core/state-machine.js";
import { ErrorTaxonomy, ErrorType, RecoveryAction } from "./core/error-taxonomy.js";
import { ReflectionEngine, ReflectionTrigger } from "./core/reflection.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// ============================================================
console.log("\n🧪 Phase 3: State Machine 测试\n");
// ============================================================

{
  const sm = new StateMachine();

  // 初始状态
  assert(sm.status === ExecutionStatus.PLANNING, "初始状态为 PLANNING");

  // 设置目标
  sm.setGoal("read package.json");
  assert(sm.currentGoal === "read package.json", "目标设置正确");

  // 合法转换 PLANNING → EXECUTING
  assert(sm.transition(ExecutionStatus.EXECUTING) === true, "PLANNING → EXECUTING 合法");

  // 非法转换 EXECUTING → PLANNING
  assert(sm.transition(ExecutionStatus.PLANNING) === false, "EXECUTING → PLANNING 非法，被拒绝");

  // 记录成功步骤
  const step1 = sm.recordStep({
    toolName: "read_file",
    arguments: { path: "package.json" },
    success: true,
    durationMs: 50,
  });
  assert(step1.id === 1, "步骤 ID 递增: 1");
  assert(sm.snapshot().completedSteps.length === 1, "已完成步骤数: 1");

  // 记录失败步骤
  sm.recordFailure({
    toolName: "read_file",
    arguments: { path: "nonexistent.txt" },
    success: false,
    errorType: "file_not_found",
    durationMs: 30,
  });
  assert(sm.snapshot().failedSteps.length === 1, "失败步骤数: 1");

  // 重试计数
  sm.incrementRetry();
  sm.incrementRetry();
  assert(sm.snapshot().retryCount === 2, "重试计数: 2");
  sm.resetRetry();
  assert(sm.snapshot().retryCount === 0, "重试计数重置为 0");

  // Token 记录
  sm.addTokens(500);
  assert(sm.snapshot().budgetUsed.tokens === 500, "Token 消耗: 500");

  // 反思记录
  sm.addReflection({
    stepId: 1,
    trigger: "consecutive_failures",
    diagnosis: "same tool keeps failing",
    newStrategy: "try grep first",
  });
  assert(sm.snapshot().reflections.length === 1, "反思记录: 1");

  // 状态转换到 REFLECTING
  assert(sm.transition(ExecutionStatus.REFLECTING) === true, "EXECUTING → REFLECTING 合法");
  assert(sm.transition(ExecutionStatus.EXECUTING) === true, "REFLECTING → EXECUTING 合法");

  // 完成
  assert(sm.transition(ExecutionStatus.COMPLETED) === true, "EXECUTING → COMPLETED 合法");
  assert(sm.transition(ExecutionStatus.FAILED) === false, "COMPLETED → FAILED 非法");

  // 重置
  sm.reset();
  assert(sm.status === ExecutionStatus.PLANNING, "重置后回到 PLANNING");
  assert(sm.snapshot().completedSteps.length === 0, "重置后步骤清零");
}

// ============================================================
console.log("\n🧪 Phase 3: Error Taxonomy 测试\n");
// ============================================================

{
  const et = new ErrorTaxonomy();

  // 超时
  const c1 = et.classify(
    { id: "1", name: "run_shell", arguments: {} },
    { success: false, error: "Command timed out after 30000ms" }
  );
  assert(c1.type === ErrorType.TIMEOUT, "超时错误正确分类");

  // 速率限制
  const c2 = et.classify(
    { id: "2", name: "llm_call", arguments: {} },
    { success: false, error: "Rate limit exceeded (429)" }
  );
  assert(c2.type === ErrorType.RATE_LIMIT, "速率限制正确分类");

  // 权限
  const c3 = et.classify(
    { id: "3", name: "write_file", arguments: {} },
    { success: false, error: "EACCES: permission denied" }
  );
  assert(c3.type === ErrorType.PERMISSION_ERROR, "权限错误正确分类");

  // 文件不存在
  const c4 = et.classify(
    { id: "4", name: "read_file", arguments: {} },
    { success: false, error: "ENOENT: no such file or directory" }
  );
  assert(c4.type === ErrorType.TOOL_ERROR, "文件不存在分类为 TOOL_ERROR");

  // 网络错误
  const c5 = et.classify(
    { id: "5", name: "fetch", arguments: {} },
    { success: false, error: "ECONNREFUSED 127.0.0.1:3000" }
  );
  assert(c5.type === ErrorType.NETWORK_ERROR, "网络错误正确分类");

  // 上下文溢出
  const c6 = et.classify(
    { id: "6", name: "llm_call", arguments: {} },
    { success: false, error: "This model's maximum context length is 128000 tokens" }
  );
  assert(c6.type === ErrorType.CONTEXT_OVERFLOW, "上下文溢出正确分类");

  // 恢复策略
  const rp1 = et.getRecoveryPlan(c1, 0);
  assert(rp1.action === RecoveryAction.RETRY_WITH_SMALLER_SCOPE, "超时 → 缩小范围重试");
  assert(rp1.countsAsRetry === true, "超时重试计入重试次数");

  const rp2 = et.getRecoveryPlan(c2, 0);
  assert(rp2.action === RecoveryAction.BACKOFF_AND_RETRY, "速率限制 → 指数退避");
  assert(rp2.delayMs > 0, "退避延迟 > 0");

  const rp3 = et.getRecoveryPlan(c3, 0);
  assert(rp3.action === RecoveryAction.REQUEST_PERMISSION, "权限 → 申请授权");
  assert(rp3.countsAsRetry === false, "权限问题不计入重试");

  const rp4 = et.getRecoveryPlan(c4, 0);
  assert(rp4.action === RecoveryAction.RETRY_WITH_ALTERNATIVE, "文件不存在 → 换路径");

  // 重试判断
  assert(et.shouldRetry(rp2, 0) === true, "退避策略: 重试 0 次，可以继续");
  assert(et.shouldRetry(rp2, 5) === false, "退避策略: 重试 5 次，应该停止");
}

// ============================================================
console.log("\n🧪 Phase 3: Reflection Engine 测试\n");
// ============================================================

{
  const re = new ReflectionEngine({ consecutiveFailureThreshold: 2 });

  // 模拟状态快照
  const baseSnapshot = {
    status: ExecutionStatus.EXECUTING,
    currentGoal: "read config file",
    completedSteps: [],
    failedSteps: [
      { id: 1, toolName: "read_file", arguments: { path: "/bad" }, success: false, errorType: "file_not_found", timestamp: Date.now(), durationMs: 10 },
      { id: 2, toolName: "read_file", arguments: { path: "/bad2" }, success: false, errorType: "file_not_found", timestamp: Date.now(), durationMs: 10 },
    ],
    retryCount: 2,
    totalSteps: 3,
    reflections: [],
    activeFiles: [],
    budgetUsed: { tokens: 100, toolCalls: 3 },
  };

  // 连续失败 → 触发反思
  re.recordOutcome("read_file", false);
  re.recordOutcome("read_file", false);
  const r1 = re.check(baseSnapshot);
  assert(r1.shouldReflect === true, "连续 2 次失败触发反思");
  assert(r1.trigger === ReflectionTrigger.CONSECUTIVE_FAILURES, "触发原因: CONSECUTIVE_FAILURES");
  assert(r1.promptForLLM!.includes("REFLECTION REQUIRED"), "反思 prompt 包含 REFLECTION REQUIRED");

  // 成功后重置
  re.recordOutcome("read_file", true);
  const r2 = re.check(baseSnapshot);
  assert(r2.shouldReflect === false, "成功后连续失败计数重置");

  // 步数过多 → 触发反思
  const manyStepsSnapshot = {
    ...baseSnapshot,
    totalSteps: 20,
    failedSteps: [],
  };
  re.reset();
  const r3 = re.check(manyStepsSnapshot);
  assert(r3.shouldReflect === true, "步数超过 15 触发反思");
  assert(r3.trigger === ReflectionTrigger.TOO_MANY_STEPS, "触发原因: TOO_MANY_STEPS");

  // 恢复策略耗尽 → 触发反思
  re.reset();
  re.recordRecoveryFailure();
  re.recordRecoveryFailure();
  re.recordRecoveryFailure();
  const r4 = re.check(baseSnapshot);
  assert(r4.shouldReflect === true, "恢复 3 次失败触发反思");
  assert(r4.trigger === ReflectionTrigger.RECOVERY_EXHAUSTED, "触发原因: RECOVERY_EXHAUSTED");

  // 生成的反思 prompt 包含关键信息
  re.reset();
  re.recordOutcome("write_file", false);
  re.recordOutcome("write_file", false);
  const r5 = re.check(baseSnapshot);
  assert(r5.promptForLLM!.includes("read config file"), "反思 prompt 包含当前目标");
  assert(r5.promptForLLM!.includes("REFLECTION:"), "反思 prompt 包含格式要求");
}

// ============================================================
// 汇总
// ============================================================
console.log(`\n${"=".repeat(50)}`);
console.log(`Phase 3 Execution Engine 测试结果: ${passed} 通过, ${failed} 失败`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("✅ Phase 3 Execution Engine 测试全部通过！\n");
  console.log("新增模块:");
  console.log("  - StateMachine: 运行时状态管理 + 状态转换校验");
  console.log("  - ErrorTaxonomy: 9 种错误分类 + 对应恢复策略");
  console.log("  - ReflectionEngine: 连续失败反思 + 策略切换建议");
  console.log("\n新增 REPL 命令:");
  console.log("  - exec: 查看执行引擎状态（状态机 + 错误 + 反思）");
}
