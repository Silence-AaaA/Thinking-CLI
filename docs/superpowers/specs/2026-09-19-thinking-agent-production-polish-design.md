# Thinking Agent 生产级回炉设计(简历叙事版)

> 日期:2026-09-19 | 版本:v1 | 状态:待评审
>
> 关联:docs/roadmap.md(Phase 7 起点)、docs/phase6-report.md、ARCHITECTURE.md

## 1. 背景与目标

### 1.1 定位

本项目是一个用于**学习 Agent 架构**的 CLI 编码 Agent(ReAct 循环)。本次回炉的目标不是「做出一个产品」,而是把一个学习项目打磨成**简历上拿得出手、面试讲得深、经得起追问**的工程作品。

### 1.2 目标(用户确认)

- **场景**:简历/作品集展示(B),不是个人日常工具,也不是企业交付。
- **标准**:真的经过测试、真的能用、有监控手段、有优化经验(D)。
- **时间窗口**:约 1 个月(B)。
- **核心诉求**:讲得出完整链路(规划 → 执行 → 观测 → 调优),有测试、有 CASE、有优化数据,并且**有自己的增量设计,不是复刻 Claude Code**。

### 1.3 核心洞察

用户自评:Phase 1-6 很多环节「没有打磨、没有思考」。实测确认最严重的问题是——**整个系统从未被真实任务验证过**。所有测试都是模块级自证,没有一个「对真实 repo 跑真实任务」的端到端验证。这是本次回炉的第一优先问题。

---

## 2. 现状审计结论(2026-09-19 实测)

### 2.1 已知健康的

- ✅ `npm run build` 编译干净(tsconfig strict=true)。
- ✅ 现有测试全绿:Phase 1 / 2 / 3 / 3-exec / 4 / 6 全部通过(Phase 6 = 92 用例)。
- ✅ 记忆层(instruction / knowledge / notebook / retrieval / prompt-builder)**已接线进 `agent.ts` 主循环**,不是孤岛。
- ✅ 生产代码统一走 `logger`,无散落 `console.log`(仅测试脚本里有)。
- ✅ `dist/`、`node_modules/`、`.env` 已被 gitignore。

### 2.2 从头到尾的明显问题(按严重度)

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| 1 | **零真实任务验证** | 无 fixture repo、无评估脚本、无通过标准 | 系统能力未知,简历无硬证据 |
| 2 | **`npm run test:all` 漏跑 4 个测试** ✅ W1 已完成(phase5 / task-router / bypass 已入 `test:all`;phase6-demo 保留为交互演示——含写盘副作用,不入自动门) | `test-phase5.ts`、`test-task-router.ts`、`test-phase6-demo.ts`、`test-bypass.ts` 未被任何 script 纳入 | 规划模块的测试没进全量入口,质量门形同虚设 |
| 3 | **测试体系分裂** ✅ W1 已完成(vitest 统一入口 + 覆盖率 + vitest.config) | 20+ 个 `tsx` 断言脚本 + 1 个孤立 vitest 文件(`core/__tests__/working-memory.test.ts`,无 script 运行) | 无统一运行器、无 coverage、无法增量扩展 |
| 4 | **无工程质量门槛** ✅ W1 已完成(biome + `npm run check`) | 无 eslint/prettier/biome/editorconfig;无 pre-commit | 风格无人把关,代码质量不可控 |
| 5 | **23 处死代码/未使用项** ✅ W1 已完成(noUnused 归零) | `npx tsc --noUnusedLocals --noUnusedParameters` 扫描:agent.ts 的 `TaskPlan`/`taskRouter`/`hashPath`;error-taxonomy/reflection/risk-assessor/prompt-builder 的 `logger`;observation/step-executor/git-tools/extraction-scheduler 的未用参数;agent-notebook/retrieval-engine/working-memory.test 的未用类型导入 | 阅读者一眼看到「没收拾过」 |
| 6 | **任务路由(DIRECT/PLAN)接线存疑** ✅ W1 已完成(`runAuto` 接线,CLI 默认走自动路由;真机分流实测→W2) | `agent.ts` 只 import 了 `TaskRouter` 但从不用;主循环直接懒加载 `TaskPlanner` | DIRECT/PLAN 分流可能从未真正生效,是面试追问高危区 |
| 7 | **Phase 6 整个未提交** ✅ W1 已完成(基线快照提交,仓库历史贯通) | `git status`:`src/memory/`、`test-phase6*.ts`、ADR-022、phase6-report 全部 untracked;核心文件还有未提交修改 | 仓库历史停在 Phase 5,叙事断档;改动无版本保护 |
| 8 | **类型逃逸** ✅ W1 已完成(`as any` 与 `obs: any` 全清) | `cli/index.ts:259` 的 `saveProjectConfig(... as any)`;`agent.ts` 的 `obs: any`、`knowledgeResult` 的 any 字段 | 破坏 strict 价值,隐藏真实缺陷 |
| 9 | **无用户向文档** ✅ W1 已完成(根 README + quickstart 更新) | 仓库根目录无 README.md;quickstart 面向开发者自测,不面向面试官叙事 | 作品展示第一眼失分 |

### 2.3 审计方法

- `git log --oneline` + `git status --short` + `git ls-files`
- `npm run build` / `npm run test:all`
- `npx tsc --noUnusedLocals --noUnusedParameters --noEmit`
- `rg` 扫描:TODO/FIXME/HACK、`as any`、`console.*`、模块接线
- 通读 `docs/roadmap.md`、`docs/phase6-report.md`、`ARCHITECTURE.md`、`package.json`

---

## 3. 方案:一个月回炉计划(A+C 融合)

### 3.1 总原则

1. **先修看得见的,再上真战场**:不把 token 花在明显坏的东西上。
2. **真话优先**:所有指标来自真实运行,不接受「自证式」测试作为能力证据。
3. **证据导向**:每周都有可落地的产物(报告/测试/数字),这些产物直接进简历叙事。
4. **消融是杀手锏**:同一个任务集,开关各子系统对比成功率——这是「我懂整个链路」的最强证据。

### 3.2 第 1 周 — S1 基线修复(从头到尾)

目标:把「一眼就看出有问题」的东西清干净,给回炉一个干净的起点。

**S1.1 工程基建**
- 统一测试入口:`npm test` 一键跑全量。纳入被遗漏的 4 个测试;用 vitest 作为统一运行器逐步迁移 tsx 脚本(或先统一包装),建立覆盖率(`vitest --coverage`)。
- 引入 lint + format:推荐 **Biome**(单工具、零配置成本、快),或 prettier + eslint 组合。
- 加 `npm run check`(tsc + lint + test)作为一键质量门。
- Git housekeeping:先把 Phase 6 现有工作提交,建立干净的基线 commit(需用户确认后再提交)。

**S1.2 代码质量清理**
- 清 23 处未使用项(删死代码/未用导入/未用参数)。
- 消灭 `as any`:`cli/index.ts` 的 `saveProjectConfig` 用正确类型;`agent.ts` 的 `extractKnowledge(obs: any)` 改为结构化类型。
- 类型补全:`knowledgeResult` 用 `KnowledgeEntry` 类型。

**S1.3 任务路由真相确认**
- 读通 `agent.ts` 主循环,确认 DIRECT/PLAN 分流是否真实生效;若未生效,决定「接通」或「明示移除并写清为什么」(两者都可讲,最怕的是「代码在但没用」)。

**S1.4 CLI/UX 打磨**
- 无 API key 时的启动引导(检测 `.env` 缺失,打印清晰指引)。
- 统一错误提示与退出码;REPL 子命令(wm/ctx/metrics 等)加帮助说明。
- `thinking --help` 输出面向用户;补根目录 README 骨架。

**S1.5 各阶段明显问题清单(以审计结果为据)**

| 阶段 | 文件 | 明显问题 |
|------|------|---------|
| 1 | `agent.ts` | 未用 `taskRouter`、`hashPath`、`TaskPlan`;`extractKnowledge(obs: any)` |
| 2 | `risk-assessor.ts` | `logger`、`lower` 未用 |
| 3 | `error-taxonomy.ts` / `reflection.ts` | `logger`、`toolName`、`lastError` 未用 |
| 3 | `observation.ts` | `toolName`、`command` 未用 |
| 4 | `step-executor.ts` | `memory` 参数未用 |
| 5 | `test-phase5.ts` 等 | 未纳入全量测试入口 |
| 6 | `memory/*` | 类型导入未用(`Observation`、`IndexEntry` 等);整个模块未提交 |
| 工具层 | `git-tools.ts` / `extraction-scheduler.ts` | 未用参数 |

**S1.6 产出(简历可见)**
- `npm test` 全绿 + 覆盖率数字
- `npm run check` 通过(lint + type + test)
- 干净的历史基线 commit

### 3.3 第 2 周 — S2 实战验证(真实能力基线)

目标:第一次用真实 LLM + 真实代码任务验证系统。

- 造 **fixture repo**(独立目录,如 `benchmark/tasks/`),5 个任务:
  1. 读代码定位并修复一个真实 bug
  2. 按需求加一个小功能
  3. 为现有模块补测试
  4. 做一次小重构(重命名/提取函数)
  5. 根据报错信息排查并修复
- 每个任务定义「通过标准」(可判定的产出,如测试通过/文件 diff 满足要点)。
- 用默认配置跑一遍,**只记录不修复** → 产出《真实能力基线报告 v1》:
  - 每任务:目标 / 执行步骤 / 成功失败 / 失败原因归类(用 error-taxonomy 分类)/ 耗时 / token 与成本
- 成本控制:DeepSeek flash,初始 5 任务 × 每任务 3-5 次调用,约几万 token。

**产出**:`docs/reports/2026-09-26-capability-baseline-v1.md` + 原始运行记录。

### 3.4 第 3 周 — S3 证据层(对齐 roadmap Phase 7)

目标:把「验证」变成「可重复的评估体系」,并做消融实验。

**S3.1 Eval Harness(评估器)**
- 任务 schema:repo + 任务描述 + 通过标准 + 预算上限
- 运行器:自动化跑任务、判定通过、汇总指标
- 指标:success rate / tool 准确率(成功调用/总调用)/ 循环数 / 成本 / 延迟
- 核心设计:**子系统开关**(knowledge / working-memory / reflection / planning 可单独关闭)

**S3.2 Telemetry(观测)**
- 结构化运行日志落盘 JSONL(在现有 logger 基础上扩展)
- `thinking telemetry` 子命令:概要、最近运行、失败分布

**S3.3 Budget Manager(预算管理)**
- token / 成本 / 时间三类预算,超限自动熔断
- 与 Eval Harness 复用同一计量层

**S3.4 首次消融实验**
- 同一任务集,分别关闭 4 个子系统,各跑一遍
- 产出对比表:哪些子系统真的提升了成功率,哪些是负优化
- 这是「自己的东西」的核心素材(即使结论是「某层无明显帮助」,也是真实的优化经验)

### 3.5 第 4 周 — S4 优化 + 叙事

目标:用数据驱动 2-3 个真实优化,并把整个项目讲成一个故事。

- 依据 S2 基线报告 + S3 消融结果,选 2-3 个优化点:
  - 例:失败最多的错误类型 → 调对应恢复策略/提示词
  - 例:context 预算再分配(compressed vs recent ratio)
  - 例:planner 粒度调整(任务拆太碎 vs 太粗)
- 改完重跑同类任务 → 《优化前后对比表》
- 叙事文档:
  - README 重写:面向面试官的一句话定位 + 架构图 + 关键决策 + 证据链接
  - `docs/narrative.md`:完整链路讲稿(规划→执行→观测→调优)+ 面试 Q&A
  - 把 ADR-001 ~ ADR-022 串成决策故事线
- 最终 demo:一个可复现的真实任务完整 run(recorded 输出,可现场演示)

---

## 4. 验收标准

| 周 | 里程碑 | 验收 |
|----|--------|------|
| W1 | 基线修复完成 | `npm run check` 全绿;删除/修复全部 23 处未用项;Phase 6 已提交;README 骨架存在 |
| W2 | 实战验证完成 | 5 个真实任务跑完;《真实能力基线报告 v1》存在,含失败归类与成本 |
| W3 | 证据层完成 | Eval Harness + Telemetry + Budget Manager 可用;首轮消融对比表产出 |
| W4 | 优化+叙事完成 | 优化前后对比表;README + narrative + Q&A;可复现 demo run |

---

## 5. 默认决定与风险

### 5.1 默认决定(可推翻)
- 报告语言:中文为主,关键图表与标题配英文(兼顾简历投递)。
- 评估成本:初始最小集(5 任务),确认链路跑通后再扩任务集。
- 工具链:Biome(lint+format 单工具),vitest 统一测试。
- fixture repo:独立目录 `benchmark/tasks/`,不复用本项目自身(避免自证)。

### 5.2 风险
- **真实能力未知(S2)**:引擎可能在真实任务上大面积翻车。对策:S2 只记录不修复;若翻车严重,W3 前插入「核心修复轮」,S3 做最小可用版,优先保「基线报告 + 修复故事」。
- **消融结果不利**:若发现某子系统是负优化,仍是加分素材(优化经验),不回避。
- **时间**:1 个月很紧。优先级:W2 基线报告 > W1 清理 > W4 叙事 > W3 证据层最小版。

---

## 6. 非目标(明确不做)

- 不做 Phase 8 的 MCP Server、多 Agent 协作、插件系统(时间不够,且非本目标核心)。
- 不做嵌入向量检索(Layer 2 增量,保留为后续方向)。
- 不做跨平台打包/服务化部署(它是 CLI 学习项目,不强装企业形态)。
- 不伪造或美化指标:所有数字必须来自真实运行。

---

## 7. 下一步

1. 用户评审本文档。
2. 批准后调用 writing-plans,产出逐周实施计划(任务拆解、文件级改动、验收)。
