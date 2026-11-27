import type { UsageSnapshot } from './types.js';

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtMins(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return hrs > 0 ? `${hrs}h ${rem}m` : `${rem}m`;
}

function csvEscape(v: string | number): string {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function renderMarkdownReport(snap: UsageSnapshot): string {
  const primary = snap.pools.find((p) => p.poolId === snap.primaryPoolId) ?? snap.pools[0];
  const f = primary.shortWindow;
  const t = snap.totals;

  const lines: string[] = [
    `# Antigravity Usage & Quota Forecast Report`,
    ``,
    `- **生成时间**: ${new Date(snap.generatedAtMs).toLocaleString()}`,
    `- **订阅套餐**: \`${snap.plan}\``,
    `- **扫描会话文件数**: ${snap.scannedFilesCount}（共 ${snap.totalEventsCount} 轮推理）`,
    ``,
    `## 1. 主力池刷新预告（${primary.displayName}）`,
    ``,
    `| 指标 | 5h 滚动短窗 | 7d 周度基线 |`,
    `| :--- | ---: | ---: |`,
    `| 当前剩余额度 | **${f.currentRemainingPct.toFixed(1)}%** | **${primary.weeklyWindow.currentRemainingPct.toFixed(1)}%** |`,
    `| **下次刷新时预告余量** | **${f.predictedRemainingPctAtReset.toFixed(1)}%** | **${primary.weeklyWindow.predictedRemainingPctAtReset.toFixed(1)}%** |`,
    `| 预测置信区间 (保守 ~ 乐观) | ${f.predictedRange.conservative.toFixed(1)}% ~ ${f.predictedRange.optimistic.toFixed(1)}% | ${primary.weeklyWindow.predictedRange.conservative.toFixed(1)}% ~ ${primary.weeklyWindow.predictedRange.optimistic.toFixed(1)}% |`,
    `| 全速连跑参考余量 | ${f.activePacePredictedRemainingPct.toFixed(1)}% | ${primary.weeklyWindow.activePacePredictedRemainingPct.toFixed(1)}% |`,
    `| 距下次刷新 | ${fmtMins(f.timeToResetMs)} | ${fmtMins(primary.weeklyWindow.timeToResetMs)} |`,
    `| 安全续航节奏 | ≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h | ≤ ${primary.weeklyWindow.safeBurnRatePctPerHour.toFixed(1)}%/h |`,
    `| 校准状态 | ${f.calibrated ? '已锚点校准' : '套餐估算'} | ${primary.weeklyWindow.calibrated ? '已锚点校准' : '套餐估算'} |`,
    ``,
    `## 2. Token 消耗总览`,
    ``,
    `| 统计范围 | 总 Tokens | Fresh Input | Cache Read | 缓存命中率 | Output | 轮次 | 工具调用 |`,
    `| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    `| 5h 窗口 | ${fmtNum(t.shortWindow.totalTokens)} | ${fmtNum(t.shortWindow.inputTokens)} | ${fmtNum(t.shortWindow.cacheReadTokens)} | ${t.shortWindow.cacheHitRate.toFixed(1)}% | ${fmtNum(t.shortWindow.outputTokens)} | ${t.shortWindow.turns} | ${t.shortWindow.toolCalls} |`,
    `| 今日 | ${fmtNum(t.today.totalTokens)} | ${fmtNum(t.today.inputTokens)} | ${fmtNum(t.today.cacheReadTokens)} | ${t.today.cacheHitRate.toFixed(1)}% | ${fmtNum(t.today.outputTokens)} | ${t.today.turns} | ${t.today.toolCalls} |`,
    `| 7 天 | ${fmtNum(t.weeklyWindow.totalTokens)} | ${fmtNum(t.weeklyWindow.inputTokens)} | ${fmtNum(t.weeklyWindow.cacheReadTokens)} | ${t.weeklyWindow.cacheHitRate.toFixed(1)}% | ${fmtNum(t.weeklyWindow.outputTokens)} | ${t.weeklyWindow.turns} | ${t.weeklyWindow.toolCalls} |`,
    `| 累计全量 | **${fmtNum(t.allTime.totalTokens)}** | ${fmtNum(t.allTime.inputTokens)} | ${fmtNum(t.allTime.cacheReadTokens)} | ${t.allTime.cacheHitRate.toFixed(1)}% | ${fmtNum(t.allTime.outputTokens)} | ${t.allTime.turns} | ${t.allTime.toolCalls} |`,
  ];

  if (snap.recommendations.length > 0) {
    lines.push('', '## 3. 智能省额与节奏建议', '');
    for (const r of snap.recommendations) {
      const icon = r.severity === 'critical' ? '🔴' : r.severity === 'warning' ? '🟡' : '💡';
      lines.push(`- ${icon} **${r.title}**：${r.detail}`);
    }
  }

  if (snap.conversations.length > 0) {
    lines.push(
      '',
      '## 4. Top 会话消耗排行',
      '',
      '| 排名 | 会话标题 | 端 | 总 Tokens | 缓存命中率 | 占比 |',
      '| ---: | :--- | :--- | ---: | ---: | ---: |',
    );
    snap.conversations.slice(0, 15).forEach((c, idx) => {
      lines.push(
        `| ${idx + 1} | ${c.title.replace(/\|/g, '\\|')} | ${c.surface} | ${c.tokens.totalTokens.toLocaleString()} | ${c.tokens.cacheHitRate.toFixed(1)}% | ${c.shareOfAllTimePct.toFixed(1)}% |`,
      );
    });
  }

  return lines.join('\n');
}

export function renderCsvReport(snap: UsageSnapshot): string {
  const header = [
    'conversation_id',
    'title',
    'surface',
    'models',
    'last_active_at',
    'turns',
    'tool_calls',
    'input_tokens',
    'cache_read_tokens',
    'output_tokens',
    'total_tokens',
    'weighted_tokens',
    'cache_hit_rate_pct',
    'share_pct',
  ].join(',');

  const rows = snap.conversations.map((c) =>
    [
      csvEscape(c.conversationId),
      csvEscape(c.title),
      csvEscape(c.surface),
      csvEscape(c.models.join(';')),
      csvEscape(c.lastActiveAt),
      c.tokens.turns,
      c.tokens.toolCalls,
      c.tokens.inputTokens,
      c.tokens.cacheReadTokens,
      c.tokens.outputTokens,
      c.tokens.totalTokens,
      c.tokens.weightedTokens,
      c.tokens.cacheHitRate,
      c.shareOfAllTimePct,
    ].join(','),
  );

  return [header, ...rows].join('\n');
}
