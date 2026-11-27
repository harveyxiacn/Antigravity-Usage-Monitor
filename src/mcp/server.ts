#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  calibrateAndSnapshot,
  collectUsageSnapshot,
  renderCsvReport,
  renderMarkdownReport,
  resetCalibrationAndSnapshot,
  simulateWorkload,
  updateConfigAndSnapshot,
  type BrainRoot,
  type PlanId,
  type PoolId,
  type UsageSnapshot,
  type WindowKind,
} from '../core/index.js';

export const APP_RESOURCE_URI = 'ui://antigravity-usage-monitor/dashboard.html';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UsageServerOptions {
  dataDir?: string;
  overrideRoots?: BrainRoot[];
  appHtmlPath?: string;
  nowProvider?: () => number;
}

function resolveAppHtmlPath(overridePath?: string): string {
  if (overridePath) return overridePath;
  if (process.env.AGY_USAGE_APP_HTML && process.env.AGY_USAGE_APP_HTML.trim()) {
    return process.env.AGY_USAGE_APP_HTML.trim();
  }
  return path.resolve(__dirname, '..', 'ui', 'index.html');
}

function loadAppHtml(overridePath?: string): string {
  const htmlPath = resolveAppHtmlPath(overridePath);
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, 'utf8');
  }
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>Antigravity Usage Monitor</title></head>
<body style="font-family:system-ui,sans-serif;padding:16px;">
  <h3>Antigravity Usage Monitor UI 未构建</h3>
  <p>请在项目根目录运行 <code>npm run build</code> 以生成单文件 MCP App HTML (${htmlPath})。</p>
</body>
</html>`;
}

function formatSummaryMarkdown(snap: UsageSnapshot): string {
  const primary = snap.pools.find((p) => p.poolId === snap.primaryPoolId) ?? snap.pools[0];
  const f = primary.shortWindow;
  const resetMin = Math.max(0, Math.round(f.timeToResetMs / 60_000));
  const resetHrs = Math.floor(resetMin / 60);
  const remMins = resetMin % 60;
  const resetStr = resetHrs > 0 ? `${resetHrs}小时${remMins}分` : `${remMins}分钟`;

  const lines = [
    `## Antigravity 额度监测与刷新预告 (${primary.displayName})`,
    `- **当前剩余额度 (5h 短窗)**: **${f.currentRemainingPct.toFixed(1)}%** (${f.calibrated ? '已校准' : `套餐 ${snap.plan} 估算`})`,
    `- **下次刷新时预告余下百分比（常规占空比）**: **${f.predictedRemainingPctAtReset.toFixed(1)}%**（保守 ${f.predictedRange.conservative.toFixed(1)}% ~ 乐观 ${f.predictedRange.optimistic.toFixed(1)}%）`,
    `- **若持续全速连跑预告余量**: ${f.activePacePredictedRemainingPct.toFixed(1)}%（有效占空比 ${Math.round(primary.burnRate.effectiveDutyCycle * 100)}%）`,
    `- **距下次刷新**: 约 **${resetStr}** (${new Date(f.nextResetAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    `- **当前融合燃烧速率**: ${primary.burnRate.blendedPctPerHour.toFixed(2)}%/h（安全预算 ≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h）`,
    `- **7 天周度基线余量**: ${primary.weeklyWindow.currentRemainingPct.toFixed(1)}%（刷新预告 ${primary.weeklyWindow.predictedRemainingPctAtReset.toFixed(1)}%）`,
  ];

  if (f.projectedLockoutMinutes && f.projectedLockoutMinutes > 0) {
    lines.push(
      `- **⚠️ 耗尽风险预警**: 按当前常规节奏预计 **${f.runwayMinutes} 分钟** 后触底，将提前断档约 **${f.projectedLockoutMinutes} 分钟**。`,
    );
  }

  const t = snap.totals;
  lines.push(
    '',
    '### Token 与等效 API 成本汇总',
    `- **累计总 Tokens (All-Time)**: **${t.allTime.totalTokens.toLocaleString()}** (${t.allTime.turns} 轮推理 · ${t.allTime.toolCalls} 次工具调用)`,
    `- **构成分解**: Fresh Input ${t.allTime.inputTokens.toLocaleString()} · Cache Read ${t.allTime.cacheReadTokens.toLocaleString()} (**命中率 ${t.allTime.cacheHitRate.toFixed(1)}%**, 节省约 ${t.allTime.savedByCacheTokens.toLocaleString()}) · Output ${t.allTime.outputTokens.toLocaleString()}`,
    `- **等效 API 费用**: 净成本 **$${t.allTime.cost.estimatedApiCostUsd.toFixed(2)}**（无缓存原价 $${t.allTime.cost.withoutCacheCostUsd.toFixed(2)} · 缓存省下 **$${t.allTime.cost.cacheSavingsUsd.toFixed(2)}**）`,
    `- **本 5h 窗口 / 今日 / 7天**: ${t.shortWindow.totalTokens.toLocaleString()} / ${t.today.totalTokens.toLocaleString()} / ${t.weeklyWindow.totalTokens.toLocaleString()}`,
  );

  if (snap.recommendations.length > 0) {
    lines.push('', '### 智能建议');
    for (const r of snap.recommendations) {
      lines.push(`- **${r.title}**: ${r.detail}`);
    }
  }

  return lines.join('\n');
}

export function createUsageMonitorServer(options: UsageServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: 'antigravity-usage-monitor',
      version: '1.2.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  const collectOpts = () => ({
    dataDir: options.dataDir,
    overrideRoots: options.overrideRoots,
    nowMs: options.nowProvider ? options.nowProvider() : Date.now(),
    enrichTitles: options.overrideRoots ? false : true,
  });

  // 1. Register MCP App UI HTML Resource
  server.registerResource(
    'Antigravity Usage Monitor Dashboard',
    APP_RESOURCE_URI,
    {
      description:
        'Interactive quota monitor, next-refresh remaining % forecaster, What-If workload simulator, project cost analytics, and 24h trends dashboard.',
      mimeType: APP_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: APP_MIME_TYPE,
          text: loadAppHtml(options.appHtmlPath),
        },
      ],
    }),
  );

  // 2. Entrypoint Tool: open_usage_monitor (aux_pane + global sidebar + model callable)
  server.registerTool(
    'open_usage_monitor',
    {
      title: 'Usage Monitor',
      description:
        'Open the interactive Antigravity Usage Monitor dashboard in the side pane or sidebar, showing real-time quota, predicted remaining % at next refresh, What-If simulator, project cost breakdown, and total token analytics.',
      inputSchema: {
        poolId: z
          .enum(['gemini-pro', 'gemini-flash', 'partner'])
          .optional()
          .describe('Optional model pool to highlight'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Usage Monitor' },
            { type: 'global', title: 'Usage Monitor' },
          ],
        },
      },
    },
    async () => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      return {
        content: [{ type: 'text', text: formatSummaryMarkdown(snapshot) }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  // 3. Inline Summary Tool
  server.registerTool(
    'get_usage_summary',
    {
      title: 'Get Antigravity Usage Summary & Refresh Forecast',
      description:
        'Get a detailed quota summary, predicted remaining percentage at next refresh (5h & 7d windows), API cost equivalent & cache savings, burn rate, and smart recommendations rendered inline.',
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async () => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      return {
        content: [{ type: 'text', text: formatSummaryMarkdown(snapshot) }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  // 4. Calibrate Quota Tool
  server.registerTool(
    'calibrate_quota',
    {
      title: 'Calibrate Quota Anchor from /usage',
      description:
        'Calibrate a model pool against Antigravity native /usage or Settings -> Models (remaining % and minutes until next refresh). Records prediction error and auto-learns exact tokens-per-percent ratio.',
      inputSchema: {
        poolId: z.enum(['gemini-pro', 'gemini-flash', 'partner']).describe('Target model quota pool'),
        windowKind: z
          .enum(['short', 'weekly'])
          .optional()
          .default('short')
          .describe('5h rolling short window or 7d weekly window'),
        remainingPct: z.number().min(0).max(100).describe('Current remaining quota percentage (0-100)'),
        resetInMinutes: z.number().positive().optional().describe('Minutes remaining until the next quota refresh'),
        nextResetAtIso: z.string().optional().describe('Optional ISO-8601 timestamp for next refresh'),
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
      },
    },
    async (args) => {
      const res = await calibrateAndSnapshot(
        {
          poolId: args.poolId as PoolId,
          windowKind: (args.windowKind ?? 'short') as WindowKind,
          remainingPct: args.remainingPct,
          resetInMinutes: args.resetInMinutes,
          nextResetAtIso: args.nextResetAtIso,
        },
        collectOpts(),
      );
      const errNote = `（校准前预测 ${res.predictedPctBefore.toFixed(1)}%，偏差 ${res.absoluteErrorPct.toFixed(1)}%）`;
      const learnedNote = res.learnedUpdated
        ? `\n已通过同周期两点校准自动更新换算系数: 1% 额度 ≈ ${res.newTokensPerPct.toLocaleString()} 加权 Tokens（原 ${res.previousTokensPerPct.toLocaleString()}）。`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `已校准 **${args.poolId}** (${args.windowKind ?? 'short'})：当前余量 ${args.remainingPct}% ${errNote}。${learnedNote}\n\n${formatSummaryMarkdown(res.snapshot)}`,
          },
        ],
        structuredContent: res as unknown as Record<string, unknown>,
      };
    },
  );

  // 5. What-If Workload Simulation Tool
  server.registerTool(
    'simulate_quota_scenario',
    {
      title: 'Simulate What-If Quota Workload',
      description:
        'Simulate how much quota will remain if you run N additional turns or M additional coding minutes, optionally offloading a percentage of work to Gemini Flash.',
      inputSchema: {
        poolId: z.enum(['gemini-pro', 'gemini-flash', 'partner']).optional(),
        windowKind: z.enum(['short', 'weekly']).optional().default('short'),
        additionalTurns: z.number().int().min(0).max(500).optional(),
        additionalMinutes: z.number().min(0).max(1440).optional(),
        offloadToFlashPct: z.number().min(0).max(100).optional().default(0),
      },
    },
    async (args) => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      const sim = simulateWorkload(snapshot, {
        poolId: args.poolId as PoolId | undefined,
        windowKind: (args.windowKind ?? 'short') as WindowKind,
        additionalTurns: args.additionalTurns,
        additionalMinutes: args.additionalMinutes,
        offloadToFlashPct: args.offloadToFlashPct,
      });
      const text = [
        `### 负载模拟推演结果 (${sim.poolId} / ${sim.windowKind})`,
        `- **当前余量**: ${sim.baselineRemainingPct.toFixed(1)}%`,
        `- **计划新增消耗**: ${sim.simulatedAddedWeightedTokens.toLocaleString()} 加权 Tokens（约 ${sim.simulatedAddedPct.toFixed(1)}%）`,
        `- **全量主力池执行后余量**: **${sim.remainingAfterWorkloadPct.toFixed(1)}%** (${sim.survivesUntilReset ? '✅ 可撑到刷新' : '🔴 将提前耗尽'})`,
        ...(sim.offloadToFlashPct > 0
          ? [
              `- **分流 ${sim.offloadToFlashPct}% 至 Gemini Flash 后余量**: **${sim.withOffloadRemainingPct.toFixed(1)}%**（为主力池省下 **${sim.savedPrimaryPct.toFixed(1)}%**，Flash 池仅消耗 ${sim.flashImpactPct.toFixed(1)}%）`,
            ]
          : []),
        `- **建议**: ${sim.recommendation}`,
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: sim as unknown as Record<string, unknown>,
      };
    },
  );

  // 6. Configure Monitor Tool
  server.registerTool(
    'configure_monitor',
    {
      title: 'Configure Antigravity Usage Monitor',
      description:
        'Update subscription plan preset, window duration, duty cycle prior, custom pool budgets, alert thresholds, or native desktop notifications.',
      inputSchema: {
        plan: z.enum(['free', 'ai-pro', 'ai-ultra', 'custom']).optional(),
        shortWindowMinutes: z.number().min(30).max(1440).optional(),
        safetyBufferPct: z.number().min(0).max(30).optional(),
        dutyCyclePrior: z.number().min(0.15).max(1.0).optional(),
        warningRemainingPct: z.number().min(1).max(80).optional(),
        criticalRemainingPct: z.number().min(1).max(50).optional(),
        alertsEnabled: z.boolean().optional(),
        desktopNotification: z.boolean().optional(),
        proShortBudget: z.number().positive().optional(),
        flashShortBudget: z.number().positive().optional(),
        partnerShortBudget: z.number().positive().optional(),
      },
    },
    async (args) => {
      const current = await collectUsageSnapshot(collectOpts());
      const hasCustomBudget = Boolean(
        args.proShortBudget || args.flashShortBudget || args.partnerShortBudget,
      );
      const snapshot = await updateConfigAndSnapshot(
        {
          ...(args.plan ? { plan: args.plan as PlanId } : {}),
          ...(args.shortWindowMinutes ? { shortWindowMinutes: args.shortWindowMinutes } : {}),
          ...(args.safetyBufferPct !== undefined ? { safetyBufferPct: args.safetyBufferPct } : {}),
          ...(args.dutyCyclePrior !== undefined ? { dutyCyclePrior: args.dutyCyclePrior } : {}),
          ...(hasCustomBudget
            ? {
                poolBudgets: {
                  'gemini-pro': {
                    ...current.config.poolBudgets['gemini-pro'],
                    ...(args.proShortBudget ? { shortWeightedTokens: args.proShortBudget } : {}),
                  },
                  'gemini-flash': {
                    ...current.config.poolBudgets['gemini-flash'],
                    ...(args.flashShortBudget ? { shortWeightedTokens: args.flashShortBudget } : {}),
                  },
                  partner: {
                    ...current.config.poolBudgets.partner,
                    ...(args.partnerShortBudget
                      ? { shortWeightedTokens: args.partnerShortBudget }
                      : {}),
                  },
                },
              }
            : {}),
          alerts: {
            ...current.config.alerts,
            ...(args.warningRemainingPct !== undefined
              ? { warningRemainingPct: args.warningRemainingPct }
              : {}),
            ...(args.criticalRemainingPct !== undefined
              ? { criticalRemainingPct: args.criticalRemainingPct }
              : {}),
            ...(args.alertsEnabled !== undefined ? { enabled: args.alertsEnabled } : {}),
            ...(args.desktopNotification !== undefined
              ? { desktopNotification: args.desktopNotification }
              : {}),
          },
        },
        collectOpts(),
      );
      return {
        content: [
          {
            type: 'text',
            text: `配置已更新：套餐=${snapshot.plan}，占空比先验=${Math.round(snapshot.config.dutyCyclePrior * 100)}%，预警线=${snapshot.config.alerts.warningRemainingPct}%，桌面弹窗=${snapshot.config.alerts.desktopNotification ? '开' : '关'}。`,
          },
        ],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  // 7. Conversation & Project Breakdown Tool
  server.registerTool(
    'get_conversation_breakdown',
    {
      title: 'Get Per-Conversation & Per-Project Token Breakdown',
      description:
        'List the highest token-consuming Antigravity conversations and projects with Fresh Input, Cache Read, Output tokens, peak context bloat diagnostics, and API cost estimates.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
    },
    async (args) => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      const top = snapshot.conversations.slice(0, args.limit ?? 10);
      const rows = top.map(
        (c, idx) =>
          `${idx + 1}. **${c.title}** [${c.projectName}] — **${c.tokens.totalTokens.toLocaleString()}** tokens (峰值上下文 ${(c.peakContextTokens / 1000).toFixed(0)}K${c.contextBloatRisk ? ' ⚠️建议/compact' : ''}, 缓存 ${c.tokens.cacheHitRate}%, 等效 $${c.tokens.cost.estimatedApiCostUsd.toFixed(2)})`,
      );
      return {
        content: [
          {
            type: 'text',
            text:
              rows.length > 0
                ? `### 会话 Token 消耗 Top ${top.length}\n${rows.join('\n')}`
                : '尚未扫描到包含 Token 遥测记录的本地会话。',
          },
        ],
        structuredContent: {
          totalConversations: snapshot.conversations.length,
          conversations: top,
          projects: snapshot.projects,
          topTools: snapshot.topTools,
        },
      };
    },
  );

  // 8. Export Usage Report Tool
  server.registerTool(
    'export_usage_report',
    {
      title: 'Export Usage & Forecast Report',
      description: 'Export a formatted Markdown, CSV, or JSON usage, cost, and refresh forecast report.',
      inputSchema: {
        format: z.enum(['markdown', 'csv', 'json']).optional().default('markdown'),
      },
    },
    async (args) => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      const fmt = args.format ?? 'markdown';
      const report =
        fmt === 'csv'
          ? renderCsvReport(snapshot)
          : fmt === 'json'
            ? JSON.stringify(snapshot, null, 2)
            : renderMarkdownReport(snapshot);
      return {
        content: [{ type: 'text', text: report }],
        structuredContent: { format: fmt, report },
      };
    },
  );

  // 9. App-Only Tools (hidden from model, callable exclusively by MCP App iframe)
  server.registerTool(
    'app_get_snapshot',
    {
      title: 'Refresh Dashboard Snapshot',
      description: 'App-only tool to fetch the latest UsageSnapshot.',
      inputSchema: {},
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_calibrate',
    {
      title: 'App Calibrate Quota',
      description: 'App-only tool to save a calibration anchor and return updated snapshot.',
      inputSchema: {
        poolId: z.enum(['gemini-pro', 'gemini-flash', 'partner']),
        windowKind: z.enum(['short', 'weekly']).optional().default('short'),
        remainingPct: z.number().min(0).max(100),
        resetInMinutes: z.number().positive().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const res = await calibrateAndSnapshot(
        {
          poolId: args.poolId as PoolId,
          windowKind: (args.windowKind ?? 'short') as WindowKind,
          remainingPct: args.remainingPct,
          resetInMinutes: args.resetInMinutes,
        },
        collectOpts(),
      );
      return {
        content: [{ type: 'text', text: 'calibrated' }],
        structuredContent: res as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_reset_calibration',
    {
      title: 'App Reset Calibration',
      description: 'App-only tool to reset calibration anchor for a pool/window.',
      inputSchema: {
        poolId: z.enum(['gemini-pro', 'gemini-flash', 'partner']).optional(),
        windowKind: z.enum(['short', 'weekly']).optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const snapshot = await resetCalibrationAndSnapshot(
        args.poolId as PoolId | undefined,
        args.windowKind as WindowKind | undefined,
        collectOpts(),
      );
      return {
        content: [{ type: 'text', text: 'reset' }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_simulate',
    {
      title: 'App Simulate Scenario',
      description: 'App-only tool to run What-If workload simulation.',
      inputSchema: {
        poolId: z.enum(['gemini-pro', 'gemini-flash', 'partner']).optional(),
        windowKind: z.enum(['short', 'weekly']).optional().default('short'),
        additionalTurns: z.number().int().min(0).max(500).optional(),
        additionalMinutes: z.number().min(0).max(1440).optional(),
        offloadToFlashPct: z.number().min(0).max(100).optional().default(0),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      const result = simulateWorkload(snapshot, {
        poolId: args.poolId as PoolId | undefined,
        windowKind: (args.windowKind ?? 'short') as WindowKind,
        additionalTurns: args.additionalTurns,
        additionalMinutes: args.additionalMinutes,
        offloadToFlashPct: args.offloadToFlashPct,
      });
      return {
        content: [{ type: 'text', text: 'simulated' }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_save_config',
    {
      title: 'App Save Config',
      description: 'App-only tool to persist monitor configuration.',
      inputSchema: {
        plan: z.enum(['free', 'ai-pro', 'ai-ultra', 'custom']).optional(),
        shortWindowMinutes: z.number().min(30).max(1440).optional(),
        safetyBufferPct: z.number().min(0).max(30).optional(),
        dutyCyclePrior: z.number().min(0.15).max(1.0).optional(),
        warningRemainingPct: z.number().min(1).max(80).optional(),
        criticalRemainingPct: z.number().min(1).max(50).optional(),
        alertsEnabled: z.boolean().optional(),
        desktopNotification: z.boolean().optional(),
        proShortBudget: z.number().positive().optional(),
        flashShortBudget: z.number().positive().optional(),
        partnerShortBudget: z.number().positive().optional(),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const current = await collectUsageSnapshot(collectOpts());
      const hasCustomBudget = Boolean(
        args.proShortBudget || args.flashShortBudget || args.partnerShortBudget,
      );
      const snapshot = await updateConfigAndSnapshot(
        {
          ...(args.plan ? { plan: args.plan as PlanId } : {}),
          ...(args.shortWindowMinutes ? { shortWindowMinutes: args.shortWindowMinutes } : {}),
          ...(args.safetyBufferPct !== undefined ? { safetyBufferPct: args.safetyBufferPct } : {}),
          ...(args.dutyCyclePrior !== undefined ? { dutyCyclePrior: args.dutyCyclePrior } : {}),
          ...(hasCustomBudget
            ? {
                poolBudgets: {
                  'gemini-pro': {
                    ...current.config.poolBudgets['gemini-pro'],
                    ...(args.proShortBudget ? { shortWeightedTokens: args.proShortBudget } : {}),
                  },
                  'gemini-flash': {
                    ...current.config.poolBudgets['gemini-flash'],
                    ...(args.flashShortBudget ? { shortWeightedTokens: args.flashShortBudget } : {}),
                  },
                  partner: {
                    ...current.config.poolBudgets.partner,
                    ...(args.partnerShortBudget
                      ? { shortWeightedTokens: args.partnerShortBudget }
                      : {}),
                  },
                },
              }
            : {}),
          alerts: {
            ...current.config.alerts,
            ...(args.warningRemainingPct !== undefined
              ? { warningRemainingPct: args.warningRemainingPct }
              : {}),
            ...(args.criticalRemainingPct !== undefined
              ? { criticalRemainingPct: args.criticalRemainingPct }
              : {}),
            ...(args.alertsEnabled !== undefined ? { enabled: args.alertsEnabled } : {}),
            ...(args.desktopNotification !== undefined
              ? { desktopNotification: args.desktopNotification }
              : {}),
          },
        },
        collectOpts(),
      );
      return {
        content: [{ type: 'text', text: 'saved' }],
        structuredContent: snapshot as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'app_export_report',
    {
      title: 'App Export Report',
      description: 'App-only tool to generate a Markdown or CSV report string.',
      inputSchema: {
        format: z.enum(['markdown', 'csv']).optional().default('markdown'),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async (args) => {
      const snapshot = await collectUsageSnapshot(collectOpts());
      const format = args.format ?? 'markdown';
      const report = format === 'csv' ? renderCsvReport(snapshot) : renderMarkdownReport(snapshot);
      return {
        content: [{ type: 'text', text: 'exported' }],
        structuredContent: { format, report },
      };
    },
  );

  return server;
}

async function startStdioServer(): Promise<void> {
  const server = createUsageMonitorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
) {
  startStdioServer().catch((err) => {
    console.error('[antigravity-usage-monitor] MCP server fatal error:', err);
    process.exit(1);
  });
}
