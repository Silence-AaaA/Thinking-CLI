/**
 * Memory Module — Information Lifecycle
 *
 * ============================================================
 * Phase 6: 从 "Memory System" 升维到 "Information Lifecycle"
 *
 * 【五层架构】
 * L1: Instruction Layer    — 层级发现 + 合并
 * L2: Knowledge Layer      — 跨会话持久化知识
 * L3: Agent Notebook       — 运行时状态（Runtime State）
 * L4: Retrieval Engine     — 模块化检索管线
 * L5: Prompt Builder       — 按 Agent 类型组装最终 prompt
 * ============================================================
 */

// Layer 1: Instruction Layer
export { InstructionLayer, type InstructionSource, type InstructionContext, type InstructionLayerConfig } from "./instruction-layer.js";

// Layer 2: Knowledge Layer
export { KnowledgeStore, type KnowledgeEntry, type KnowledgeType, type KnowledgeScope, type KnowledgeSource, type IndexEntry, type KnowledgeIndex, type KnowledgeStoreConfig } from "./knowledge-layer.js";

// Layer 3: Agent Notebook
export { AgentNotebookManager, type AgentNotebookData, type GoalState, type PlanState, type StepState, type BlockedState, type Decision, type NotebookObservation, type WorklogEntry, type AgentNotebookConfig } from "./agent-notebook.js";

// Layer 4: Retrieval Engine
export { RetrievalEngine, MetadataFilter, ImportanceFilter, RecencyFilter, RelevanceRanker, type RetrievalQuery, type RetrievalResult, type ScoredEntry, type RetrievalFilter, type RetrievalRanker, type RetrievalEngineConfig } from "./retrieval-engine.js";

// Layer 5: Prompt Builder
export { PromptBuilder, type PromptBuilderConfig, type PromptComponents, type AssembleReport, type AssembledPrompt, type AgentType } from "./prompt-builder.js";

// Extraction Scheduler
export { ExtractionScheduler, type ExtractionTriggerConfig } from "./extraction-scheduler.js";
