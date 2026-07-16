/**
 * 测试脚本语言绕过检测（v2 新增）
 */

import { RiskAssessor, RiskLevel, ApprovalDecision } from "./core/risk-assessor.js";
import type { ToolCall } from "./tools/types.js";

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test-${Date.now()}`, name, arguments: args };
}

async function test() {
  console.log("=== 测试脚本语言绕过检测 ===\n");
  const assessor = new RiskAssessor();

  const cases: Array<{
    name: string;
    command: string;
    expectedLevel: RiskLevel;
    expectedDecision: ApprovalDecision;
  }> = [
    {
      name: "python os.remove（等价 rm）",
      command: "python -c \"import os; os.remove('test.txt')\"",
      expectedLevel: RiskLevel.DESTRUCTIVE,
      expectedDecision: ApprovalDecision.CONFIRM,
    },
    {
      name: "python shutil.rmtree（等价 rm -rf）",
      command: "python -c \"import shutil; shutil.rmtree('dist')\"",
      expectedLevel: RiskLevel.DESTRUCTIVE,
      expectedDecision: ApprovalDecision.CONFIRM,
    },
    {
      name: "node fs.unlinkSync（等价 rm）",
      command: "node -e \"require('fs').unlinkSync('test.txt')\"",
      expectedLevel: RiskLevel.DESTRUCTIVE,
      expectedDecision: ApprovalDecision.CONFIRM,
    },
    {
      name: "node fs.rmSync（等价 rm）",
      command: "node -e \"require('fs').rmSync('test.txt')\"",
      expectedLevel: RiskLevel.DESTRUCTIVE,
      expectedDecision: ApprovalDecision.CONFIRM,
    },
    {
      name: "rimraf（等价 rm -rf）",
      command: "npx rimraf dist",
      expectedLevel: RiskLevel.DESTRUCTIVE,
      expectedDecision: ApprovalDecision.CONFIRM,
    },
    {
      name: "python 正常 print（不危险）",
      command: "python -c \"print('hello')\"",
      expectedLevel: RiskLevel.EXECUTE,
      expectedDecision: ApprovalDecision.ALLOW,
    },
    {
      name: "node 正常 console.log（不危险）",
      command: "node -e \"console.log(1)\"",
      expectedLevel: RiskLevel.EXECUTE,
      expectedDecision: ApprovalDecision.ALLOW,
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = assessor.assess(makeToolCall("run_shell", { command: tc.command }));
    const ok = result.level === tc.expectedLevel && result.decision === tc.expectedDecision;
    
    if (ok) {
      console.log(`  ✅ ${tc.name} → ${result.level}/${result.decision}`);
      passed++;
    } else {
      console.log(`  ❌ ${tc.name}`);
      console.log(`     Command:  ${tc.command}`);
      console.log(`     Expected: ${tc.expectedLevel}/${tc.expectedDecision}`);
      console.log(`     Got:      ${result.level}/${result.decision}`);
      console.log(`     Reason:   ${result.reason}`);
      failed++;
    }
    if (result.risks.length > 0) {
      result.risks.forEach(r => console.log(`     ⚠️  ${r}`));
    }
  }

  console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
  
  console.log("✅ 脚本绕过检测测试通过！\n");
}

test();
