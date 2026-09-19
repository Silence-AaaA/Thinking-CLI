# Thinking Agent - 学习路线图 v2.2

> 基于"能力域"模型。详见 `docs/plans/2026-07-16-system-architecture-design.md`

## Phase 完成状态

### Phase 1: Agent Loop — 基础循环 ✅
- [x] LLM 适配器（OpenAI 兼容 + 重试 + 指数退避）
- [x] ReAct 循环（思考→行动→观察）
- [x] 循环控制（maxIterations + 停止条件 + 达上限后 LLM 总结）
- [x] Doom Loop 检测（相同调用连续失败 N 次自动停止）
- [x] 输出截断（head+tail 策略，保留尾部错误信息）
- [x] 系统提示词（停止规则 + 验证规则 + 失败处理规则）

### Phase 2: Tool System — 能力边界 ✅
- [x] 工具接口定义（Tool Schema，与 OpenAI function calling 对齐）
- [x] 工具注册表（Registry + 动态注册）
- [x] 6 个内置工具（file_summary / read_file / write_file / list_dir / grep / find_files）
- [x] Shell 工具（白名单 + 危险模式拦截）
- [x] Git 工具（status / diff / log，结构化输出）
- [x] 风险评估器（Risk Assessor，5 级风险）
- [x] 审批网关（Approval Gateway，ALLOW/CONFIRM/DENY）
- [x] 审计日志（每条操作记录风险等级、决策、结果）
- [x] **Observation Layer（观察层）** — 5 个专用提取器
  - FileReadExtractor — 提取行数/函数/类名
  - SearchExtractor — 提取匹配数 + 前 5 个匹配
  - ShellExtractor — 提取测试结果/错误摘要/关键输出
  - GitExtractor — 提取分支/变更/提交
  - GenericExtractor — 通用兜底
- [x] 错误分类基础版（file_not_found / permission_error / timeout / rate_limit 等）
- [x] 恢复建议（每种错误类型对应建议下一步）

### Phase 3: Execution Engine — 可靠执行 ✅
- [x] **State Machine（状态机）** — 运行时状态不进 Prompt
  - currentGoal / completedSteps / failedSteps / retryCount
  - activeFiles / budget / executionStatus
  - 6 种状态：PLANNING → EXECUTING → REFLECTING / RECOVERING → COMPLETED / FAILED
  - 合法状态转换校验（防止非法跳转）
- [x] **Error Taxonomy（错误分类增强）** — 9 种错误类型 + 对应恢复策略
  - Tool Error → 换路径（RETRY_WITH_ALTERNATIVE）
  - Validation Error → 重新生成参数（REGENERATE_PARAMS）
  - Permission Error → 申请审批（REQUEST_PERMISSION）
  - Timeout → 缩小范围重试（RETRY_WITH_SMALLER_SCOPE）
  - Rate Limit → 指数退避（BACKOFF_AND_RETRY）
  - Context Overflow → 压缩上下文（COMPRESS_CONTEXT）
  - Network Error → 重试（SIMPLE_RETRY）
  - Schema Error → 重新生成（REGENERATE_PARAMS）
  - Hallucination → 校验后纠正（CORRECT_AND_RETRY）
- [x] **Recovery Strategies（恢复策略）** — 根据错误类型自动选择恢复方式
  - 每种策略包含：action / hintForLLM / countsAsRetry / delayMs / maxRetries
  - 恢复提示自动附加到 Observation 输出
- [x] **Reflection（反思机制）** — 连续失败时停下来换策略
  - 触发条件 1：同一目标连续失败 2 次 → CONSECUTIVE_FAILURES
  - 触发条件 2：总步数超过 15 步 → TOO_MANY_STEPS
  - 触发条件 3：恢复策略连续失败 3 次 → RECOVERY_EXHAUSTED
  - 输出：reflection + diagnosis + new_strategy（注入 LLM prompt）
- [x] **Agent 主循环集成** — 三大模块无缝嵌入 ReAct 循环
  - 每次工具调用自动更新状态机
  - 失败时自动分类 + 选择恢复策略 + 注入提示
  - 连续失败自动触发反思（注入 prompt 引导 LLM 换策略）
- [x] **CLI exec 命令** — REPL 中查看执行引擎完整状态

### Phase 4: Context Engineering — 信息管理 ✅ (Phase 4.6 升级完成)
- [x] **Working Memory（工作记忆）** — 当前任务关键信息（不进对话历史）
  - 5 类信息：currentGoal / findings / activeFiles / recentErrors / decisions
  - 重要度分级（low / medium / high），超限自动淘汰低重要度
  - 每轮自动更新，格式化注入 prompt
- [x] **History Compressor（历史压缩）** — 早期对话压缩为摘要
  - 规则压缩（不用 LLM），按轮次分割
  - 保留最近 N 轮完整对话，更早的压缩为结构化摘要
  - 提取：用户输入、工具名、结果摘要、助手回复
- [x] **Context Assembler（上下文组装器）** — 组装最终送给 LLM 的消息
  - 分层组装：System → Working Memory → State Snapshot → Recent History → Summary
  - Token 上限保护（超过上下文窗口自动截断）
  - 空 Working Memory 不注入（避免浪费空间）
- [x] **Retrieval（按需检索）** — 按需获取文件/知识，不预载（Phase 6 Retrieval Engine 完成）

### Phase 5: Planning — 任务规划 ✅
- [x] **Task Router（任务路由）** — 判断任务应该走 DIRECT 还是 PLAN 路径
- [x] **Task Planner（任务分解）** — 四阶段规划：Goal Analysis → Dependency Discovery → Task Decomposition → Execution Plan
- [x] **Step Executor（步骤执行）** — 每步 → 工具调用序列
- [x] **Dynamic Replanner（动态重规划）** — 执行中发现问题 → 调整计划
- [x] **Recursive Decomposition（递归拆解）** — 大任务 → 子任务 → ... → 原子任务

### Phase 6: Memory — Information Lifecycle ✅
- [x] **Instruction Layer** — 层级发现 + 合并（Global / Project / Local / Managed）
  - [x] 4 级指令源发现（Managed → Global → Project → Local）
  - [x] 优先级反转加载（低优先级先注入，利用 recency bias）
  - [x] 目录遍历（从根目录向 CWD 逐级发现 THINKING.md）
  - [x] @include 指令支持（模块化指令组织 + 循环引用检测）
- [x] **Knowledge Layer** — 跨会话持久化知识（Framework 核心）
  - [x] Flat Storage（uuid.json 扁平存储，分类全靠 metadata）
  - [x] KnowledgeEntry 模型（content + reason + type/scope/importance/confidence/tags）
  - [x] index.json 索引（轻量摘要，避免全量加载）
  - [x] Knowledge Store（存/取/删 + gc 淘汰）
  - [x] Knowledge Extraction（规则提取：从 WM + Observation 抽取高价值条目）
- [x] **Agent Notebook** — 运行时状态（不是 Summary，是 Runtime State）
  - [x] 结构化字段：Goal / Plan / Step / Blocked / Decision / Observation / Worklog
  - [x] 双阈值触发（token 增长 + tool call 计数）
  - [x] 与 Compact 联动（Notebook 快照替代重新总结）
  - [x] Multi-Agent 可直接共享（结构化数据，非自然语言）
- [x] **Retrieval Engine** — 模块化检索管线
  - [x] MetadataFilter（按 type / scope / tags 过滤）
  - [x] RecencyFilter（按时间衰减）
  - [x] RelevanceRanker（综合 importance * confidence * recency）
  - [x] 可替换策略接口（未来接入 Embedding）
- [x] **Prompt Builder** — 从 ContextAssembler 重构
  - [x] 分层组装：Instruction + Notebook + Knowledge + History
  - [x] Agent 类型差异化（coding / research / general）
  - [x] 保留 AssembleReport / HistoryCheckpoint / ContextChangelog
  - [x] Token 预算保护

### Phase 7: Reliability — 可靠性 ⬜
- [ ] **Evaluation（评估体系）** — 成功率 / 工具准确率 / 循环次数 / 成本 / 延迟
- [ ] **Telemetry（观测系统）** — 结构化指标采集 + Dashboard
- [ ] **Budget Manager（预算管理）** — Token/成本/时间预算

### Phase 8: Production — 生产级 ⬜
- [ ] MCP Server 集成
- [ ] 安全沙盒增强（目录级权限）
- [ ] 多 Agent 协作
- [ ] 插件系统

## 测试命令

```bash
npm run test              # Phase 1 基础测试
npm run test:phase2       # Phase 2 Observation Layer 测试
npm run test:phase3       # Phase 3 审批系统测试
npm run test:phase3-exec  # Phase 3 执行引擎测试（State Machine + Error Taxonomy + Reflection）
npm run test:phase4       # Phase 4 上下文工程测试（Working Memory + Compressor + Assembler）
npm run test:phase6       # Phase 6 Information Lifecycle 测试
  npm run test:all          # 全部测试
```

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/plans/2026-07-16-system-architecture-design.md` | **系统架构设计（主文档）** |
| `docs/architecture.md` | 架构学习手册 |
| `docs/phase1-2-report.md` | Phase 1-2 完成报告 |
| `docs/phase3-report.md` | Phase 3 审批系统报告 |
| `docs/quickstart.md` | 快速开始 |
| `docs/phase6-report.md` | Phase 6 Information Lifecycle 报告 |

## 项目结构

```
src/
├── core/
│   ├── agent.ts              ← ReAct 循环 + 所有能力层集成
│   ├── risk-assessor.ts      ← 风险评估器（5 级）
│   ├── approval-gateway.ts   ← 审批网关 + 审计日志
│   ├── observation.ts        ← Observation Layer（5 个提取器）
│   ├── state-machine.ts      ← 运行时状态机（6 种状态 + 转换校验）
│   ├── error-taxonomy.ts     ← 9 种错误分类 + 恢复策略引擎
│   ├── reflection.ts         ← 反思机制（连续失败 / 步数过多 / 恢复耗尽）
│   ├── working-memory.ts     ← 工作记忆（关键信息 + 重要度分级）
│   ├── history-compressor.ts ← 历史压缩（规则压缩 + 按轮次分割）
│   └── context-assembler.ts  ← 上下文组装器（分层组装 + token 保护）
├── tools/
│   ├── types.ts              ← 工具接口
│   ├── registry.ts           ← 注册表
│   ├── file-tools.ts         ← 分层读取
│   ├── search-tools.ts       ← 搜索优先
│   ├── shell-tool.ts         ← 安全执行
│   └── git-tools.ts          ← Git 操作
├── llm/
│   ├── types.ts              ← LLM 接口
│   └── openai-adapter.ts     ← OpenAI 兼容实现
├── memory/
│   ├── instruction-layer.ts  ← 指令层级发现（Global/Project/Local/Managed）
│   ├── knowledge-layer.ts    ← 知识持久化（flat uuid.json + reason + metadata）
│   ├── agent-notebook.ts     ← 运行时状态（Goal/Plan/Step/Decision/Observation/Worklog）
│   ├── retrieval-engine.ts   ← 模块化检索管线（Filter Chain + Ranker）
│   ├── prompt-builder.ts     ← 按 Agent 类型组装最终 prompt
│   ├── extraction-scheduler.ts ← 双阈值触发（token + tool calls）
│   └── index.ts              ← 模块导出
├── utils/logger.ts           ← 结构化日志
└── cli/index.ts              ← CLI 入口（REPL + 审批 + exec/wm/ctx/metrics/ctxdiff）
```














