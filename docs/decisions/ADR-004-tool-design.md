# ADR-004: 工具接口设计与 Token 经济学

> Phase 2 | 状态：已实现

## 背景

工具是 Agent 的"手脚"。怎么定义工具、怎么设计工具的返回值，直接决定了 Agent 的能力和效率。

## 决策 1：工具接口与 OpenAI function calling 对齐

```typescript
interface Tool {
  name: string;
  description: string;        // LLM 根据这个决定用不用
  parameters: JSONSchema;     // LLM 根据这个决定怎么传参
  execute: (params) => Promise<ToolResult>;
}
```

description 的质量 = Agent 的智商。写得模糊，LLM 就会乱用工具。

## 决策 2：Token 经济学 — 分层读取

文件读取分三层：

| 工具 | 消耗 | 用途 |
|------|------|------|
| `list_dir` | ~100 token | 看目录结构 |
| `file_summary` | ~80 token | 看文件结构（函数/类名） |
| `read_file` | 按行数 | 读具体内容 |

**核心原则**：先用便宜的工具定位，再用贵的工具深入。

## 决策 3：搜索优先于读取

```
❌ 读所有文件再搜索 → 5000+ token
✅ 先 grep 定位 → 再 read_file 读上下文 → ~200 token
```

grep 工具默认返回位置（file:line），不返回完整内容。
LLM 看到位置后自己决定要不要读上下文。

## 决策 4：工具返回值精简

每个工具返回 `ToolResult`，包含 `tokenEstimate` 字段。
这样可以追踪每个工具消耗了多少 token。

## 关键文件

- `src/tools/types.ts` — 工具接口定义
- `src/tools/file-tools.ts` — 分层读取实现
- `src/tools/search-tools.ts` — 搜索优先实现
- `src/tools/registry.ts` — 工具注册表
