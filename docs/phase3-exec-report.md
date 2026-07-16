# Phase 3 Execution Engine 完成报告 — 可靠执行

## 设计决策

**核心思路**：在 Agent 的 ReAct 循环中嵌入三层执行保障 — 状态机追踪进展、错误分类驱动恢复、反思机制防止死循环。

```
工具调用完成
       ↓
  StateMachine（记录步骤 / 更新状态）
       ↓
  ┌── 成功 → 重置重试计数 → 继续
  └── 失败 → ErrorTaxonomy（分类错误）
               ↓
          RecoveryPlan（选择恢复策略）
               ↓
          ReflectionEngine（是否需要反思？）
               ↓
          ┌── 不需要 → 注入恢复提示，继续
          └── 需要 → 注入反思 prompt，引导 LLM 换策略
```

## 新增模块

### 1. State Machine — 运行时状态机

**文件**: `src/core/state-machine.ts`

6 种状态 + 合法转换校验：
```
PLANNING → EXECUTING → REFLECTING ↔ RECOVERING
                ↓              ↓
           COMPLETED       FAILED
```

追踪内容：
- `currentGoal` — 当前目标
- `completedSteps` — 成功步骤列表
- `failedSteps` — 失败步骤列表（含错误类型）
- `retryCount` — 重试计数
- `reflections` — 反思历史
- `activeFiles` — 涉及的文件
- `budgetUsed` — Token/工具调用消耗

### 2. Error Taxonomy — 错误分类 + 恢复策略

**文件**: `src/core/error-taxonomy.ts`

9 种错误类型 + 对应恢复策略：

| 错误类型 | 恢复策略 | 延迟 | 最大重试 |
|---------|---------|------|---------|
| `tool_error` | RETRY_WITH_ALTERNATIVE（换路径） | 0 | 3 |
| `validation_error` | REGENERATE_PARAMS（重新生成参数） | 0 | 2 |
| `permission_error` | REQUEST_PERMISSION（申请授权） | 0 | 1 |
| `timeout` | RETRY_WITH_SMALLER_SCOPE（缩小范围） | 1000ms | 2 |
| `rate_limit` | BACKOFF_AND_RETRY（指数退避） | 2^n × 2s | 5 |
| `context_overflow` | COMPRESS_CONTEXT（压缩上下文） | 0 | 1 |
| `network_error` | SIMPLE_RETRY（简单重试） | 3000ms | 3 |
| `schema_error` | REGENERATE_PARAMS | 0 | 2 |
| `hallucination` | CORRECT_AND_RETRY（校正后重试） | 0 | 2 |

### 3. Reflection Engine — 反思机制

**文件**: `src/core/reflection.ts`

3 种触发条件：
- **CONSECUTIVE_FAILURES**: 同一工具连续失败 2 次
- **TOO_MANY_STEPS**: 总步数超过 15 步
- **RECOVERY_EXHAUSTED**: 恢复策略连续失败 3 次

反思输出注入到 LLM prompt：
```
## ⚠️ REFLECTION REQUIRED
**Trigger**: consecutive_failures
**Current goal**: read config file
**Recent failures**: ...
**Suggested direction**: Try listing the directory first...
```

## Agent 主循环改造

**文件**: `src/core/agent.ts` — 集成三大模块

每次工具调用后的处理流程：
1. 成功 → `stateMachine.recordStep()` + `reflectionEngine.recordOutcome(true)` + `resetRetry()`
2. 失败 → `errorTaxonomy.classify()` → `getRecoveryPlan()` → `stateMachine.recordFailure()` → `reflectionEngine.check()`
3. 如果触发反思 → 注入反思 prompt 到对话历史
4. 恢复提示自动附加到 Observation 输出末尾

## CLI 更新

新增 REPL 命令 `exec`，显示执行引擎完整状态：
```
⚙️  Execution Engine:
  Status: executing
  Goal: read config file
  Total Steps: 5
  Completed: 3
  Failed: 2
  Retry Count: 1
  Tokens Used: 2500
  Active Files: src/config.ts, package.json
  Reflections: 1
    1. [consecutive_failures] same tool keeps failing → try grep first
  Recent Failures:
    - Step 4: read_file → tool_error
```

## 测试结果

```
State Machine:      20/20 通过 ✅
Error Taxonomy:     15/15 通过 ✅
Reflection Engine:   7/7  通过 ✅
─────────────────────────────
总计:               42/42 通过 ✅
全量回归:           0 失败 ✅
```

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/state-machine.ts` | 新增 | 运行时状态机 |
| `src/core/error-taxonomy.ts` | 新增 | 错误分类 + 恢复策略 |
| `src/core/reflection.ts` | 新增 | 反思引擎 |
| `src/core/agent.ts` | 修改 | 集成三大模块 |
| `src/cli/index.ts` | 修改 | 新增 exec 命令 + 版本升级 |
| `src/test-phase3-exec.ts` | 新增 | 42 个测试用例 |
| `package.json` | 修改 | 新增 test:phase3-exec 脚本 |
| `docs/roadmap.md` | 修改 | Phase 3 标记完成 |
| `docs/phase3-exec-report.md` | 新增 | 本报告 |

## 下一步

Phase 4: Context Engineering — 上下文管理
- Context Assembler（上下文组装器）
- History Compressor（历史压缩）
- Working Memory（工作记忆）
- Retrieval（按需检索）
