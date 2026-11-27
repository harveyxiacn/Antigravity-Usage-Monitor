#!/usr/bin/env node
import {
  buildUsageSnapshot,
  loadState,
  saveState,
  scanTranscripts,
  type BrainRoot,
  type ForecastResult,
  type UsageSnapshot,
} from '../core/index.js';

export interface HookPayload {
  conversationId?: string;
  modelName?: string;
  hookEventName?: string;
  transcriptPath?: string;
}

export interface HookOutput {
  injectSteps?: Array<{
    systemMessage: {
      systemMessage: string;
      metadata?: {
        user_markdown?: string;
      };
    };
  }>;
  terminationBehavior?: '' | 'terminate' | 'force_continue';
}

function formatMins(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hrs > 0) return `${hrs}小时${mins}分`;
  return `${mins}分钟`;
}

function buildAlertMarkdown(snapshot: UsageSnapshot, forecast: ForecastResult): string {
  const pool = snapshot.pools.find((p) => p.poolId === snapshot.primaryPoolId) ?? snapshot.pools[0];
  const resetMins = Math.max(1, Math.round(forecast.timeToResetMs / 60_000));
  const icon = forecast.status === 'critical' || forecast.status === 'exhausted' ? '🔴' : '🟡';
  const lockoutNote =
    forecast.projectedLockoutMinutes && forecast.projectedLockoutMinutes > 0
      ? `预计 **${formatMins(forecast.runwayMinutes ?? 0)}** 后耗尽（可能提前断档约 ${formatMins(forecast.projectedLockoutMinutes)}）。`
      : `按当前节奏，刷新时预计余量 **${forecast.predictedRemainingPctAtReset.toFixed(1)}%**（区间 ${forecast.predictedRange.conservative.toFixed(1)}%–${forecast.predictedRange.optimistic.toFixed(1)}%）。`;

  return [
    `> ${icon} **Antigravity 额度预警 (${pool.displayName})**`,
    `> 当前余量 **${forecast.currentRemainingPct.toFixed(1)}%** · 距下次刷新约 **${formatMins(resetMins)}** · ${lockoutNote}`,
    `> 本窗口累计消耗 **${snapshot.totals.shortWindow.totalTokens.toLocaleString()}** tokens（缓存命中 ${snapshot.totals.shortWindow.cacheHitRate.toFixed(1)}%）· 建议将节奏控制在 ≤ **${forecast.safeBurnRatePctPerHour.toFixed(1)}%/h** 或临时切至 Flash 模型。`,
  ].join('\n');
}

export function evaluatePostInvocationHook(
  _payload: HookPayload,
  options: {
    dataDir?: string;
    nowMs?: number;
    overrideRoots?: BrainRoot[];
  } = {},
): HookOutput {
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(options.dataDir);
  const scan = scanTranscripts(state.config, state.scanCache, options.overrideRoots);
  state.scanCache = scan.cache;

  const snapshot = buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );

  if (!state.config.alerts.enabled) {
    try {
      saveState(state, options.dataDir);
    } catch {
      // ignore read-only cache persistence failure
    }
    return {};
  }

  const forecast = snapshot.overallShort;
  const shouldAlert =
    forecast.status === 'warning' ||
    forecast.status === 'critical' ||
    forecast.status === 'exhausted' ||
    (forecast.projectedLockoutMinutes !== null && forecast.projectedLockoutMinutes > 0);

  if (!shouldAlert) {
    try {
      saveState(state, options.dataDir);
    } catch {
      // ignore read-only cache persistence failure
    }
    return {};
  }

  const alertKey = `${snapshot.primaryPoolId}:${forecast.status}`;
  const lastAlert = state.lastAlertAtMs[alertKey] ?? 0;
  const cooldownMs = Math.max(1, state.config.alerts.cooldownMinutes) * 60_000;

  if (nowMs - lastAlert < cooldownMs) {
    try {
      saveState(state, options.dataDir);
    } catch {
      // ignore read-only cache persistence failure
    }
    return {};
  }

  state.lastAlertAtMs[alertKey] = nowMs;
  try {
    saveState(state, options.dataDir);
  } catch {
    // ignore read-only cache persistence failure
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: buildAlertMarkdown(snapshot, forecast),
          },
        },
      },
    ],
    terminationBehavior: '',
  };
}

async function runCliHook(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let payload: HookPayload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as HookPayload;
    } catch {
      payload = {};
    }
  }
  const output = evaluatePostInvocationHook(payload);
  process.stdout.write(JSON.stringify(output));
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')
) {
  runCliHook().catch(() => {
    process.stdout.write('{}');
  });
}
