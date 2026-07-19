# ADR-021: Run Report JSON 导出

> Phase 4.7 | 状态：已实现

## 背景

ADR-016 实现了 Runtime Metrics 采集，但数据只活在内存里。
每次运行结束后，如果想做以下事情，都需要手动提取：
- 比较多次运行的效果
- 统计哪类错误最贵
- 建立评估体系（自动判断"这次运行好不好"）
- 给用户展示运行摘要

没有标准化导出格式，metrics 就只是"运行时日志"，不是"可评估的数据"。

## 决策

在 Agent 层新增 `exportRunReport(): RunReport` 方法，
输出标准化 JSON 报告：

```
RunReport {
  goal                  // 本次任务目标
  finalStatus           // completed / failed / max_iterations
  startedAt, finishedAt, durationMs
  steps                 // 总步数
  tokens                // 总 token 消耗
  toolCalls             // 工具调用次数
  retries               // 重试次数
  reflections           // 反思触发次数
  toolUsage             // 各工具使用次数 { "read_file": 5, "grep": 3 }
  failureCategories     // 各类错误次数 { "file_not_found": 2, "timeout": 1 }
  warnings              // 运行时警告列表
}
```

数据来源：RuntimeMetrics（运行时采集） + StateMachine（当前状态）。

## 为什么不只用 RuntimeMetrics.currentSnapshot()

currentSnapshot() 包含内部实现细节（如 workingMemoryVersionStart/End），
不适合直接作为外部评估接口。

RunReport 是"面向评估的视图"：
- 字段命名面向业务语义（steps、tokens），不面向内部实现
- 结构稳定，不随内部重构变化
- 可直接用于 JSON 序列化、存储、对比

## 为什么不自动生成报告文件

文件写入是 IO 操作，应该由调用方决定。
Agent 只提供 `exportRunReport()` 返回数据，
调用方可以选择：
- 写入文件
- 发送到监控系统
- 在 CLI 中打印摘要
- 存入数据库

## 关键收益

- 每次运行输出标准 JSON，可存储、可比较
- 为自动化评估体系提供数据源
- 为 A/B 测试不同策略提供基础
- 为用户展示运行摘要提供数据

## 关键文件

- `src/core/agent.ts` — RunReport 接口 + exportRunReport()
- `src/core/runtime-metrics.ts` — 数据采集来源
