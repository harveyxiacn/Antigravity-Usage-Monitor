#!/usr/bin/env node
import {
  calibrateAndSnapshot,
  collectUsageSnapshot,
  renderCsvReport,
  renderMarkdownReport,
  resetCalibrationAndSnapshot,
  simulateWorkload,
  updateConfigAndSnapshot,
  type PlanId,
  type PoolId,
  type UsageSnapshot,
  type WindowKind,
} from '../core/index.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtCountdown(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function statusAnsi(status: string): string {
  if (status === 'healthy') return ANSI.green;
  if (status === 'caution' || status === 'warning') return ANSI.yellow;
  return ANSI.red;
}

function renderBar(pct: number, width = 24, status = 'healthy'): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  const empty = Math.max(0, width - filled);
  return `${statusAnsi(status)}${'█'.repeat(filled)}${ANSI.dim}${'░'.repeat(empty)}${ANSI.reset}`;
}

function renderSparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values
    .map((v) => {
      if (v <= 0) return `${ANSI.dim}·${ANSI.reset}`;
      const idx = Math.min(
        SPARK_BLOCKS.length - 1,
        Math.floor((v / max) * (SPARK_BLOCKS.length - 1)),
      );
      return `${ANSI.cyan}${SPARK_BLOCKS[idx]}${ANSI.reset}`;
    })
    .join('');
}

function renderDashboardText(snap: UsageSnapshot): string {
  const lines: string[] = [];
  const primary = snap.pools.find((p) => p.poolId === snap.primaryPoolId) ?? snap.pools[0];
  const f = primary.shortWindow;
  const resetLocal = new Date(f.nextResetAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  lines.push(
    `${ANSI.bold}${ANSI.cyan}╔══════════════════════════════════════════════════════════════════════╗${ANSI.reset}`,
  );
  lines.push(
    `${ANSI.bold}${ANSI.cyan}║${ANSI.reset}  ${ANSI.bold}Antigravity Usage Monitor v1.2${ANSI.reset}  ${ANSI.dim}[Plan: ${snap.plan.toUpperCase()} | ${new Date(snap.generatedAtMs).toLocaleTimeString()}]${ANSI.reset}`,
  );
  lines.push(
    `${ANSI.bold}${ANSI.cyan}╚══════════════════════════════════════════════════════════════════════╝${ANSI.reset}`,
  );
  lines.push('');

  lines.push(
    `${ANSI.bold}▶ 主力模型池预测 (${primary.displayName} · 5h 短窗)${ANSI.reset} ${f.calibrated ? `${ANSI.green}[已校准]${ANSI.reset}` : `${ANSI.dim}[套餐估算]${ANSI.reset}`}`,
  );
  lines.push(
    `  当前剩余额度: ${renderBar(f.currentRemainingPct, 26, f.status)} ${ANSI.bold}${f.currentRemainingPct.toFixed(1)}%${ANSI.reset}`,
  );
  lines.push(
    `  下次刷新预告: ${renderBar(f.predictedRemainingPctAtReset, 26, f.status)} ${statusAnsi(f.status)}${ANSI.bold}${f.predictedRemainingPctAtReset.toFixed(1)}%${ANSI.reset}  ${ANSI.dim}(保守 ${f.predictedRange.conservative.toFixed(1)}% ~ 乐观 ${f.predictedRange.optimistic.toFixed(1)}% | 全速连跑 ${f.activePacePredictedRemainingPct.toFixed(1)}%)${ANSI.reset}`,
  );
  lines.push(
    `  下次刷新时间: ${ANSI.bold}${resetLocal}${ANSI.reset} (倒计时 ${ANSI.cyan}${fmtCountdown(f.timeToResetMs)}${ANSI.reset})   安全节奏: ${ANSI.bold}≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h${ANSI.reset} (${fmtNum(f.safeTokensPerMinute)} tok/m)`,
  );
  lines.push(
    `  融合燃烧速率: ${ANSI.bold}${primary.burnRate.blendedPctPerHour.toFixed(2)}%/h${ANSI.reset} ${ANSI.dim}(占空比 ${Math.round(primary.burnRate.effectiveDutyCycle * 100)}% · 全速 ${primary.burnRate.rawActivePctPerHour.toFixed(1)}%/h · ${fmtNum(primary.burnRate.tokensPerMinute)} tok/m)${ANSI.reset}`,
  );
  if (f.projectedLockoutMinutes && f.projectedLockoutMinutes > 0) {
    lines.push(
      `  ${ANSI.red}${ANSI.bold}⚠ 预警: 按常规占空比节奏约 ${f.runwayMinutes} 分钟后耗尽，将提前断档 ${f.projectedLockoutMinutes} 分钟！${ANSI.reset}`,
    );
  }
  lines.push('');

  const t = snap.totals;
  lines.push(`${ANSI.bold}▶ Token 与等效 API 成本统计${ANSI.reset}`);
  lines.push(
    `  累计总 Tokens : ${ANSI.bold}${fmtNum(t.allTime.totalTokens)}${ANSI.reset} (${t.allTime.totalTokens.toLocaleString()})  | 轮次: ${t.allTime.turns} | 工具调用: ${t.allTime.toolCalls}`,
  );
  lines.push(
    `  构成拆解      : Fresh Input ${ANSI.cyan}${fmtNum(t.allTime.inputTokens)}${ANSI.reset} | Cache Read ${ANSI.green}${fmtNum(t.allTime.cacheReadTokens)}${ANSI.reset} (${t.allTime.cacheHitRate.toFixed(1)}%) | Output ${ANSI.yellow}${fmtNum(t.allTime.outputTokens)}${ANSI.reset}`,
  );
  lines.push(
    `  等效 API 成本 : 净额 ${ANSI.bold}${fmtUsd(t.allTime.cost.estimatedApiCostUsd)}${ANSI.reset} | 无缓存原价 ${ANSI.dim}${fmtUsd(t.allTime.cost.withoutCacheCostUsd)}${ANSI.reset} | 缓存净省 ${ANSI.green}${ANSI.bold}${fmtUsd(t.allTime.cost.cacheSavingsUsd)}${ANSI.reset}`,
  );
  lines.push(
    `  时间窗对比    : 5h窗口 ${fmtNum(t.shortWindow.totalTokens)} | 今日 ${fmtNum(t.today.totalTokens)} | 7天 ${fmtNum(t.weeklyWindow.totalTokens)} | 24h脉冲 [${renderSparkline(snap.hourlyTrend24h.map((b) => b.totalTokens))}]`,
  );
  lines.push('');

  lines.push(`${ANSI.bold}▶ 各模型配额池一览${ANSI.reset}`);
  for (const p of snap.pools) {
    lines.push(
      `  ${p.displayName.padEnd(28)} 5h剩 ${p.shortWindow.currentRemainingPct.toFixed(1).padStart(5)}% → 刷新剩 ${statusAnsi(p.shortWindow.status)}${p.shortWindow.predictedRemainingPctAtReset.toFixed(1).padStart(5)}%${ANSI.reset} | 7d剩 ${p.weeklyWindow.currentRemainingPct.toFixed(1).padStart(5)}% | 5hTok ${fmtNum(p.shortTokens.totalTokens).padStart(7)}`,
    );
  }

  if (snap.projects.length > 0) {
    lines.push('');
    lines.push(`${ANSI.bold}▶ 项目 / 工作区消耗${ANSI.reset}`);
    for (const proj of snap.projects.slice(0, 4)) {
      lines.push(
        `  • ${proj.projectName.padEnd(28)} ${fmtNum(proj.tokens.totalTokens).padStart(7)} tok  (${proj.conversationCount}会话 · 等效 ${fmtUsd(proj.tokens.cost.estimatedApiCostUsd)} · 占 ${proj.shareOfAllTimePct.toFixed(1)}%)`,
      );
    }
  }

  if (snap.recommendations.length > 0) {
    lines.push('');
    lines.push(`${ANSI.bold}▶ 智能省额与节奏建议${ANSI.reset}`);
    for (const r of snap.recommendations.slice(0, 3)) {
      const color = r.severity === 'critical' ? ANSI.red : r.severity === 'warning' ? ANSI.yellow : ANSI.cyan;
      lines.push(`  ${color}• ${r.title}${ANSI.reset}: ${ANSI.dim}${r.detail}${ANSI.reset}`);
    }
  }

  if (snap.conversations.length > 0) {
    lines.push('');
    lines.push(`${ANSI.bold}▶ Top 会话消耗${ANSI.reset}`);
    for (const c of snap.conversations.slice(0, 5)) {
      const shortTitle = c.title.length > 34 ? `${c.title.slice(0, 31)}...` : c.title;
      const bloatTag = c.contextBloatRisk ? ` ${ANSI.yellow}[峰值${fmtNum(c.peakContextTokens)} 建议/compact]${ANSI.reset}` : '';
      lines.push(
        `  • ${shortTitle.padEnd(36)} ${fmtNum(c.tokens.totalTokens).padStart(7)} tok  (缓存 ${c.tokens.cacheHitRate.toFixed(0).padStart(2)}%, ${c.tokens.turns}轮)${bloatTag}`,
      );
    }
  }

  lines.push('');
  lines.push(
    `${ANSI.dim}提示: "agy-usage simulate --turns 20 --offload 50" 负载推演 | "agy-usage calibrate ..." 校准 | "agy-usage report --format md" 导出${ANSI.reset}`,
  );
  return lines.join('\n');
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  return undefined;
}

function printHelp(): void {
  console.log(`Antigravity Usage Monitor CLI v1.2

用法:
  agy-usage [status|forecast] [--json]       查看当前额度、刷新预告、成本与总 Tokens
  agy-usage watch [--interval 5]             终端实时监控面板 (默认每 5 秒刷新)
  agy-usage projects [--json]                按项目/工作区查看 Token 与等效 API 成本
  agy-usage conversations [--limit 15]       查看会话 Token 排行榜与上下文膨胀诊断
  agy-usage simulate [--turns 20] [--minutes 60] [--offload 50] [--pool gemini-pro]
                                             What-If 负载模拟推演（含 Flash 分流收益）
  agy-usage calibrate --pool <pool> --remaining <pct> --reset-mins <mins> [--window short|weekly]
                                             对照 Antigravity /usage 进行锚点校准与误差追踪
  agy-usage reset-calibration [--pool <pool>] 重置校准锚点
  agy-usage config --plan <free|ai-pro|ai-ultra|custom> [--duty 0.45] [--warn 20] [--crit 10] [--desktop true|false]
                                             修改订阅套餐、占空比、预警阈值与桌面通知
  agy-usage report [--format md|csv|json]    导出 Markdown / CSV / JSON 完整报告`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  const asJson = args.includes('--json');

  if (cmd === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (cmd === 'status' || cmd === 'forecast' || cmd === 'export') {
    const snap = await collectUsageSnapshot();
    if (asJson || cmd === 'export') {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(renderDashboardText(snap));
    }
    return;
  }

  if (cmd === 'projects') {
    const snap = await collectUsageSnapshot();
    if (asJson) {
      console.log(JSON.stringify(snap.projects, null, 2));
      return;
    }
    console.log(`${ANSI.bold}Antigravity 项目 / 工作区消耗统计${ANSI.reset}\n`);
    for (const p of snap.projects) {
      console.log(
        `${ANSI.bold}${p.projectName}${ANSI.reset} (${p.conversationCount} 会话 · 主力 ${p.topModel})\n  总 Tokens: ${p.tokens.totalTokens.toLocaleString()} (占比 ${p.shareOfAllTimePct}%) | 缓存命中: ${p.tokens.cacheHitRate}% | 等效费用: ${fmtUsd(p.tokens.cost.estimatedApiCostUsd)} (缓存省 ${fmtUsd(p.tokens.cost.cacheSavingsUsd)})`,
      );
    }
    return;
  }

  if (cmd === 'simulate') {
    const snap = await collectUsageSnapshot();
    const pool = getFlag(args, '--pool') as PoolId | undefined;
    const windowKind = (getFlag(args, '--window') ?? 'short') as WindowKind;
    const turns = getFlag(args, '--turns');
    const minutes = getFlag(args, '--minutes');
    const offload = getFlag(args, '--offload');

    const sim = simulateWorkload(snap, {
      poolId: pool,
      windowKind,
      additionalTurns: turns ? Number(turns) : undefined,
      additionalMinutes: minutes ? Number(minutes) : undefined,
      offloadToFlashPct: offload ? Number(offload) : 0,
    });
    if (asJson) {
      console.log(JSON.stringify(sim, null, 2));
      return;
    }
    console.log(`${ANSI.bold}${ANSI.cyan}What-If 负载模拟推演 (${sim.poolId} / ${sim.windowKind})${ANSI.reset}`);
    console.log(`  当前余量           : ${sim.baselineRemainingPct.toFixed(1)}%`);
    console.log(
      `  计划新增消耗       : ${fmtNum(sim.simulatedAddedWeightedTokens)} 加权 Tokens (${sim.simulatedAddedPct.toFixed(1)}%)`,
    );
    console.log(
      `  纯主力池执行后余量 : ${sim.survivesUntilReset ? ANSI.green : ANSI.red}${ANSI.bold}${sim.remainingAfterWorkloadPct.toFixed(1)}%${ANSI.reset} (${sim.survivesUntilReset ? '可撑到刷新' : '将提前耗尽'})`,
    );
    if (sim.offloadToFlashPct > 0) {
      console.log(
        `  分流 ${sim.offloadToFlashPct}% 至 Flash : ${ANSI.green}${ANSI.bold}${sim.withOffloadRemainingPct.toFixed(1)}%${ANSI.reset} (省下 ${sim.savedPrimaryPct.toFixed(1)}%, Flash 仅耗 ${sim.flashImpactPct.toFixed(1)}%)`,
      );
    }
    console.log(`  建议               : ${sim.recommendation}`);
    return;
  }

  if (cmd === 'report') {
    const fmt = (getFlag(args, '--format') ?? 'md').toLowerCase();
    const snap = await collectUsageSnapshot();
    if (fmt === 'csv') {
      console.log(renderCsvReport(snap));
    } else if (fmt === 'json') {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      console.log(renderMarkdownReport(snap));
    }
    return;
  }

  if (cmd === 'watch') {
    const intervalSec = Math.max(2, Number(getFlag(args, '--interval') ?? '5'));
    const renderTick = async () => {
      const snap = await collectUsageSnapshot();
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(renderDashboardText(snap));
      console.log(`${ANSI.dim}实时监控中 (每 ${intervalSec}s 刷新 · 按 Ctrl+C 退出)${ANSI.reset}`);
    };
    await renderTick();
    setInterval(() => {
      void renderTick();
    }, intervalSec * 1000);
    return;
  }

  if (cmd === 'conversations') {
    const limit = Math.max(1, Number(getFlag(args, '--limit') ?? '15'));
    const snap = await collectUsageSnapshot();
    if (asJson) {
      console.log(JSON.stringify(snap.conversations.slice(0, limit), null, 2));
      return;
    }
    console.log(`${ANSI.bold}Antigravity 会话 Token 排行榜 (Top ${limit})${ANSI.reset}\n`);
    for (const c of snap.conversations.slice(0, limit)) {
      const bloat = c.contextBloatRisk ? ` ${ANSI.yellow}⚠ 上下文偏大(${fmtNum(c.peakContextTokens)})${ANSI.reset}` : '';
      console.log(
        `${c.title} [${c.projectName}]${bloat}\n  ID: ${c.conversationId} | 端: ${c.surface} | 总计: ${c.tokens.totalTokens.toLocaleString()} (峰值 ${fmtNum(c.peakContextTokens)}, 缓存 ${c.tokens.cacheHitRate}%, 等效 ${fmtUsd(c.tokens.cost.estimatedApiCostUsd)})`,
      );
    }
    return;
  }

  if (cmd === 'calibrate') {
    const pool = (getFlag(args, '--pool') ?? 'gemini-pro') as PoolId;
    const windowKind = (getFlag(args, '--window') ?? 'short') as WindowKind;
    const remainingStr = getFlag(args, '--remaining');
    const resetMinsStr = getFlag(args, '--reset-mins');
    if (remainingStr === undefined) {
      console.error('错误: 请提供 --remaining <0-100>');
      process.exitCode = 1;
      return;
    }
    const result = await calibrateAndSnapshot({
      poolId: pool,
      windowKind,
      remainingPct: Number(remainingStr),
      resetInMinutes: resetMinsStr ? Number(resetMinsStr) : undefined,
    });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `✅ 校准已保存 (${pool} / ${windowKind}) · 校准前预测 ${result.predictedPctBefore.toFixed(1)}%，偏差 ${result.absoluteErrorPct.toFixed(1)}%`,
      );
      if (result.learnedUpdated) {
        console.log(
          `📈 已通过两点校准自动更新换算系数: 1% 额度 ≈ ${result.newTokensPerPct.toLocaleString()} 加权 Tokens (原 ${result.previousTokensPerPct.toLocaleString()})`,
        );
      }
      console.log(renderDashboardText(result.snapshot));
    }
    return;
  }

  if (cmd === 'reset-calibration') {
    const pool = getFlag(args, '--pool') as PoolId | undefined;
    const windowKind = getFlag(args, '--window') as WindowKind | undefined;
    await resetCalibrationAndSnapshot(pool, windowKind);
    console.log('✅ 已重置校准锚点。');
    return;
  }

  if (cmd === 'config') {
    const plan = getFlag(args, '--plan') as PlanId | undefined;
    const duty = getFlag(args, '--duty');
    const warn = getFlag(args, '--warn');
    const crit = getFlag(args, '--crit');
    const desktop = getFlag(args, '--desktop');
    const current = await collectUsageSnapshot();
    const snap = await updateConfigAndSnapshot({
      ...(plan ? { plan } : {}),
      ...(duty ? { dutyCyclePrior: Number(duty) } : {}),
      ...(warn || crit || desktop !== undefined
        ? {
            alerts: {
              ...current.config.alerts,
              ...(warn ? { warningRemainingPct: Number(warn) } : {}),
              ...(crit ? { criticalRemainingPct: Number(crit) } : {}),
              ...(desktop !== undefined ? { desktopNotification: desktop === 'true' } : {}),
            },
          }
        : {}),
    });
    console.log(
      `✅ 配置已更新 (Plan: ${snap.plan}, 占空比先验: ${snap.config.dutyCyclePrior}, 预警线: ${snap.config.alerts.warningRemainingPct}%, 桌面通知: ${snap.config.alerts.desktopNotification ? '开' : '关'})`,
    );
    return;
  }

  console.error(`未知命令: ${cmd}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exitCode = 1;
});
