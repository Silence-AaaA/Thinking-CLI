# ADR-016: Runtime Metrics 设计

> Phase 4.6 | 状态：已实现

## 背景

前面几个阶段让 Agent “能工作”，但还不能回答：
- 这次运行花了多少 token？
- 哪类错误最常见？
- 反思触发了几次？
- context 被压缩/裁剪了多少次？

没有 metrics，优化就只能靠主观感觉。

## 决策

为每次 `Agent.run()` 建立一个 `RuntimeMetrics` 采集器：
- loops
- toolCalls
- retries
- reflections
- compressions
- dropped messages
- contextVersions
- prompt / completion / total tokens
- failure categories
- tool usage
- durationMs

## 为什么不只用 logger

logger 是“过程日志”，metrics 是“运行结果指标”。  
logger 能帮你 Debug，metrics 能帮你 Optimize。

## 关键收益

- 每次运行结束后可输出 run report
- 可比较不同策略效果
- 可定位哪类失败最贵

## 关键文件

- `src/core/runtime-metrics.ts`
- `src/core/agent.ts`
- `src/cli/index.ts`
