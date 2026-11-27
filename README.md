# Antigravity Usage Monitor

专为 **Google Antigravity**（Desktop 2.0 / IDE / CLI）打造的 **本地零遥测额度监测与 Token 分析工具**。集 **Antigravity 原生 MCP App 插件（侧边栏 + 全页 + 对话内嵌）**、**PostInvocation 低额自动预警 Hook** 与 **独立 CLI/TUI 实时看板** 于一体。

## 核心特性

- **下次刷新时余下百分比预告（核心能力）**：
  - 同时建模 **5 小时滚动短窗（5h Rolling Window）** 与 **7 天周度基线（7d Weekly Cap）**。
  - 采用 **EWMA + 近期速率 + 窗口均速融合燃烧率估计** 与活跃静默衰减模型，给出 **乐观 / 预期 / 保守（P10–P90）** 刷新余量预测区间。
  - 若当前速率将在下次刷新前触底，自动计算 **耗尽倒计时（Runway ETA）**、**预计断档分钟数** 与 **安全续航节奏预算（Safe Pace）**。
- **精细化 Token 总量与缓存分析**：
  - 增量扫描本地官方 `transcript.jsonl`（覆盖 `antigravity`、`antigravity-cli`、`antigravity-ide`），基于字节偏移缓存实现毫秒级刷新。
  - 精准拆解 **总 Tokens**、**Fresh Input**、**Prompt Cache Read**（附 **缓存命中率 %** 与 **缓存节省 Token**）、**Output Tokens**、**调用轮次**、**工具调用排行** 及 **会话消耗排行**。
- **一键锚点校准与自学习换算系数**：
  - 100% 合规零侵入，不探测任何未公开本地端口。
  - 对照原生 `/usage` 或 `Settings → Models` 输入当前剩余百分比与刷新倒计时即可锚定；同一周期内校准 2 次可自动学习每 1% 额度对应的精确加权 Token 系数。
- **原生 Antigravity MCP App 仪表盘**：
  - 基于 `@modelcontextprotocol/ext-apps` 打包为单文件 HTML，自动同步宿主亮/暗主题变量，支持侧边栏 (`aux_pane`)、全局导航 (`global`) 与对话内嵌 (`inline`)。
- **无感低额预警 Hook**：
  - 在 `PostInvocation` 钩子中检查预测余量，仅在触发预警/高危阈值时通过 `user_markdown` 向用户展示精简横幅，**不额外消耗任何模型 Token**，内置防打扰冷却期。

---

## 快速开始

### 1. 安装依赖与构建

```bash
npm install
npm run build
```

### 2. 运行测试

```bash
npm test
```

### 3. 使用独立 CLI / 终端实时看板

```bash
# 查看当前额度、刷新预告与总 Tokens
npm run cli -- status

# 终端实时监控模式（每 5 秒刷新）
npm run cli -- watch --interval 5

# 查看会话消耗排行
npm run cli -- conversations --limit 10

# 对照 Antigravity 原生 /usage 校准（例如 Gemini Pro 还剩 72%，距刷新 135 分钟）
npm run cli -- calibrate --pool gemini-pro --remaining 72 --reset-mins 135

# 切换套餐预设（free / ai-pro / ai-ultra / custom）与活跃占空比先验
npm run cli -- config --plan ai-pro --duty 0.45 --warn 20 --crit 10

# 导出 Markdown / CSV / JSON 使用与预测报告
npm run cli -- report --format md
npm run cli -- report --format csv
```

### 4. 一键安装为 Antigravity 插件（含 MCP App + Hook + Skill）

```bash
npm run install-plugin
```

安装完成后，插件会被写入 `~/.gemini/config/plugins/antigravity-usage-monitor/`，Antigravity 会自动发现：
- 在侧边栏 `+` 菜单或左侧全局导航中打开 **Usage Monitor** 可视化仪表盘。
- 在对话中直接问：“打开额度监控面板”、“预告下次刷新还剩多少百分比”或“统计总共用了多少 tokens”。

---

## 详细设计文档

完整系统架构、双窗口数学建模、自学习校准公式与目录说明请参阅 [DESIGN.md](./DESIGN.md)。
