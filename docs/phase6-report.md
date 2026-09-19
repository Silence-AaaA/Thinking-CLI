# Phase 6: Information Lifecycle — 完成报告

> 从 "Memory System" 升维到 "Information Lifecycle"

## 设计背景

Phase 6 原计划实现传统的三层记忆（Session / Project / Long-term Memory），但在深入分析 Claude Code 的四层记忆架构后，发现"记忆系统"这个抽象层级过低。真正需要管理的是**信息的完整生命周期**：

Conversation → Extraction → Classification → Storage → Retrieval → Context Construction → LLM

Memory 只是其中的 Storage 环节。基于这个认知，将 Phase 6 从 "Memory System" 升维到 "Information Lifecycle"，采用五层架构。

## 核心设计原则

1. **Storage 越 Dumb 越好** — 存储层只管存取删，所有分类/过滤/排序交给上层
2. **Classification 全靠 Metadata** — 不用物理目录结构，topic 迁移零成本
3. **每条知识带 reason** — 不只知道"是什么"，还知道"为什么"
4. **Notebook 是 Runtime State 不是 Summary** — 结构化数据，Multi-Agent 可直接共享
5. **借鉴 Claude 的架构思想，不复刻 Claude 的实现细节**

## 五层架构

- L1: Instruction Layer — Discovery → Merge → Priority → Context
- L2: Knowledge Layer — flat uuid.json + content/reason/metadata
- L3: Agent Notebook — Runtime State (Goal/Plan/Step/Blocked/Decision/Observation/Worklog)
- L4: Retrieval Engine — MetadataFilter → ImportanceFilter → RelevanceRanker
- L5: Prompt Builder — Instruction + Notebook + Knowledge → LLM（按 Agent 类型差异化）

## 实现清单

### Layer 1: Instruction Layer (instruction-layer.ts)
- [x] 4 级指令源发现：Managed → Global → Project → Local
- [x] 优先级反转加载（低优先级先注入，利用 LLM recency bias）
- [x] 目录遍历（从根目录向 CWD 逐级发现 THINKING.md）
- [x] @include 指令支持（递归解析 + 循环引用检测 + 深度限制）
- [x] 缓存机制（session 级）

### Layer 2: Knowledge Layer (knowledge-layer.ts)
- [x] Flat uuid.json 存储（不用 topic 目录）
- [x] KnowledgeEntry 模型：content + reason + type/scope/importance/confidence/tags
- [x] reason 字段 — Claude Code 没有做好的设计
- [x] index.json 轻量索引（避免全量加载）
- [x] Knowledge Store（save / load / delete / count）
- [x] GC 淘汰（过期 + 低重要度自动清理）
- [x] 从 Decision 自动提取知识（extractFromDecision）
- [x] 从 Observation 自动提取知识（extractFromObservation，低价值信息跳过）

### Layer 3: Agent Notebook (agent-notebook.ts)
- [x] 结构化字段：Goal / Plan / Step / Blocked / Decision / Observation / Worklog
- [x] 完整生命周期：setGoal → beginStep → completeStep → finishGoal
- [x] Blocked 状态管理（attempts 累计 + suggestion）
- [x] 从 StateMachine 同步状态
- [x] 从 Observation / Reflection 自动更新
- [x] snapshot / loadSnapshot（Multi-Agent 共享基础）
- [x] formatForLLM（可读的运行时状态文本）

### Layer 4: Retrieval Engine (retrieval-engine.ts)
- [x] 策略模式 Filter Chain 接口
- [x] MetadataFilter（按 type / scope / tags 过滤）
- [x] ImportanceFilter（过滤低重要度条目）
- [x] RecencyFilter（按时间衰减）
- [x] RelevanceRanker（综合 importance * confidence * recency * accessBoost）
- [x] 可动态注册/替换 filter 和 ranker
- [x] formatForLLM（可读的检索结果文本）

### Layer 5: Prompt Builder (prompt-builder.ts)
- [x] 从 ContextAssembler 重构
- [x] 分层组装：System → Notebook → Knowledge → State → History
- [x] Agent 类型差异化：coding / research / general 各有附加指令
- [x] 保留 AssembleReport / HistoryCheckpoint / ContextChangelog
- [x] Token 预算保护
- [x] History 压缩（复用现有 HistoryCompressor）

### Extraction Scheduler (extraction-scheduler.ts)
- [x] 双阈值触发（token 增长 + tool call 计数）
- [x] 初始化阶段延迟
- [x] 自然暂停时无 tool call 也可触发
- [x] 序列化 / 恢复（checkpoint 支持）

## 与 Claude Code 的对比

| 设计点 | Claude Code | Thinking Agent | 改进 |
|---|---|---|---|
| 指令发现 | 4 类型 + 目录遍历 | 4 类型 + 目录遍历 + @include | 对齐 |
| 知识存储 | topics/ 目录 + MEMORY.md 索引 | flat uuid.json + index.json | 更灵活，迁移零成本 |
| 知识模型 | content + metadata | content + reason + metadata | 多了 "为什么" |
| Session 记忆 | 10 段模板（AI 填写） | Runtime State（自动更新） | 更精确，无需 LLM |
| 提取机制 | 后台 Agent（昂贵） | 规则提取（零成本） | 适合学习框架 |
| 检索 | Header + LLM Selector | Filter Chain（可替换） | 更模块化 |
| Prompt 组装 | 固定管线 | 按 Agent 类型差异化 | 更灵活 |

## 测试覆盖

- 92 个测试用例，全部通过
- 覆盖：5 层架构 + Extraction Scheduler + 两个集成场景
- 现有 Phase 1-4 测试未受影响

## 文件清单

src/memory/instruction-layer.ts — L1: 指令层级发现
src/memory/knowledge-layer.ts — L2: 知识持久化
src/memory/agent-notebook.ts — L3: 运行时状态
src/memory/retrieval-engine.ts — L4: 模块化检索
src/memory/prompt-builder.ts — L5: Prompt 构建
src/memory/extraction-scheduler.ts — 双阈值触发
src/memory/index.ts — 模块导出
src/test-phase6.ts — 测试（92 cases）
docs/phase6-report.md — 本文档
docs/decisions/ADR-022-information-lifecycle.md — 架构决策记录

## 后续方向

- Phase 7: 评估体系（成功率 / 工具准确率 / 循环次数 / 成本 / 延迟）
- Phase 8: 生产级（MCP Server / 安全沙盒 / 多 Agent 协作 / 插件系统）
- Layer 2 增量: 嵌入向量检索（替换 RelevanceRanker 为 EmbeddingRanker）
- Layer 3 增量: 多 Agent 共享 Notebook 的实际集成
