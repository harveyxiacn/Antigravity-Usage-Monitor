# Antigravity Usage Monitor

[![CI](https://github.com/harveyxiacn/Antigravity-Usage-Monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/harveyxiacn/Antigravity-Usage-Monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

专为 **Google Antigravity**（Desktop 2.0 / IDE / CLI）打造的 **本地零遥测额度监测、刷新余量预测与 Token 成本分析工具**。集 **Antigravity 原生 MCP App 插件（侧边栏 + 全页 + 对话内嵌）**、**PostInvocation 对话内 + 桌面弹窗低额预警 Hook** 与 **独立 CLI/TUI 实时看板** 于一体。

## 核心特性（v1.2.0）

- **下次刷新时余下百分比预告（核心能力）**：
  - 同时建模 **5 小时滚动短窗（5h Rolling Window）** 与 **7 天周度基线（7d Weekly Cap）**。
  - 采用 **EWMA + 贝叶斯自适应占空比正则化 + 静默衰减模型**，避免冷启动短时爆发误报，同时输出 **常规占空比预测（含 P10–P90 置信区间）** 与 **全速连跑参考值**。
  - 触底风险自动计算 **耗尽倒计时（Runway ETA）**、**预计断档分钟数** 与 **安全续航节奏预算（Safe Pace）**。
- **What-If 负载模拟推演器**：
  - 预测“接下来再跑 N 轮 / M 分钟，或把 X% 任务分流给 Gemini Flash”后还能剩多少额度，直观量化分流收益。
- **精细化 Token、按项目聚合与等效 API 费用计算**：
  - 基于 `mtimeMs + byteOffset` 增量扫描 `transcript.jsonl`（覆盖 `antigravity` / `antigravity-cli` / `antigravity-ide`），毫秒级刷新。
  - 精准拆解 **总 Tokens**、**Fresh Input**、**Prompt Cache Read（命中率 % 与节省量）**、**Output Tokens**、**等效 API 净成本 & 缓存省钱（USD）**、**按项目/工作区统计**、**24h 柱状趋势 / 7d 趋势** 及 **工具调用 Top 15**。
- **上下文膨胀诊断（Context Bloat Detector）**：
  - 追踪每个会话的单轮峰值上下文 Token，超过 200K 时主动标记并建议运行 `/compact`。
- **一键锚点校准、误差追踪（MAE）与自学习系数**：
  - 100% 本地合规，不探测未公开端口。对照 `/usage` 或 `Settings → Models` 校准即可记录预测偏差（MAE），同周期校准 2 次自动学习你的真实 `tokensPerPct` 系数。
- **双通道低额自动预警 Hook**：
  - `PostInvocation` 触发对话内 `user_markdown` 精简横幅（零额外模型 Token 消耗）+ 可选 Windows/macOS/Linux 原生桌面弹窗通知，内置防打扰冷却期。

---

## 快速开始

### 1. 安装依赖与构建

```bash
npm install
npm run build
npm test
```

### 2. 使用独立 CLI / 终端实时看板

```bash
# 查看当前额度、刷新预告、等效 API 成本、项目统计与 24h 脉冲
npm run cli -- status

# 终端实时监控模式（每 5 秒刷新）
npm run cli -- watch --interval 5

# What-If 负载模拟推演（例：再跑 20 轮，50% 分流给 Gemini Flash）
npm run cli -- simulate --turns 20 --offload 50

# 按工作区/项目查看消耗与等效成本
npm run cli -- projects

# 查看会话排行与上下文膨胀诊断
npm run cli -- conversations --limit 10

# 对照 Antigravity 原生 /usage 校准（例：Gemini Pro 余量 72%，距刷新 135 分钟）
npm run cli -- calibrate --pool gemini-pro --remaining 72 --reset-mins 135

# 修改订阅套餐、占空比先验、预警线与桌面弹窗开关
npm run cli -- config --plan ai-pro --duty 0.45 --warn 20 --crit 10 --desktop true

# 导出 Markdown / CSV / JSON 完整报告
npm run cli -- report --format md
npm run cli -- report --format csv
```

### 3. 一键安装为 Antigravity 插件（含 MCP App + Hook + Skill）

```bash
npm run install-plugin
```

安装完成后插件部署在 `~/.gemini/config/plugins/antigravity-usage-monitor/`，Antigravity 自动发现：
- 在右侧辅助面板 `+` 菜单或左侧全局导航栏打开 **Usage Monitor** 交互仪表盘（自动适配亮/暗主题）；
- 在对话中直接问：“打开额度监控面板”、“模拟再跑 25 轮并分流 50% 给 Flash 后剩多少额度”或“导出 Markdown 消耗报告”。

---

## 详细设计文档

完整系统架构、双窗口数学建模、自学习校准公式与目录说明请参阅 [DESIGN.md](./DESIGN.md)。
