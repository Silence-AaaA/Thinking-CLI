> 面向简历 / 展示：先运行 `npm test` 确认环境就绪，再按下方命令集体验；`npx thinking <task>` 会自动路由任务（DIRECT / PLAN）。真实任务基线报告与优化对比见 `docs/reports/`。

# 快速开始

## 1. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的 API 配置：

```bash
cp .env.example .env
```

编辑 `.env`：
```env
# OpenAI 或兼容 API
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# 或者使用其他兼容 API（如 DeepSeek）
# OPENAI_BASE_URL=https://api.deepseek.com/v1
# OPENAI_MODEL=deepseek-chat
```

## 2. 安装依赖

```bash
npm install
```

## 3. 运行

### 单次任务模式
```bash
npm run dev -- "帮我看看当前目录的结构"
```

### 交互式 REPL 模式
```bash
npm run repl
```

### 详细日志模式
```bash
npm run dev -- --verbose "找到所有 TODO 注释"
```

## 4. REPL 命令

在 REPL 模式下：
- 直接输入任务描述，Agent 会执行
- `state` - 查看当前状态（步骤数、token 消耗等）
- `reset` - 清除对话历史
- `exit` - 退出

## 5. 学习建议

1. **先跑通**：配置好 API，运行一个简单任务
2. **看日志**：用 `--verbose` 看 Agent 的思考过程
3. **读代码**：从 `src/core/agent.ts` 开始，理解 ReAct 循环
4. **做实验**：
   - 让 Agent 读一个文件，观察它怎么调用工具
   - 让 Agent 搜索代码，观察它怎么用 grep
   - 故意给一个模糊的任务，观察它怎么处理
5. **改代码**：
   - 修改系统提示词，看 Agent 行为怎么变化
   - 添加一个新工具
   - 修改最大迭代次数，观察影响
