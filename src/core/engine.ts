import {
  ALL_POOLS,
  DEFAULT_PRICING,
  POOL_DISPLAY_NAMES,
  calibrationKey,
} from './config.js';
import type {
  BurnRateEstimate,
  CalibrationAccuracySummary,
  CalibrationAnchor,
  CalibrationHistoryEntry,
  CalibrationInput,
  ConfidenceLevel,
  ConversationMeta,
  ConversationSummary,
  CostBreakdown,
  DailyBucket,
  ForecastResult,
  HealthStatus,
  HourlyBucket,
  ModelBreakdownSummary,
  MonitorConfig,
  PersistentState,
  PoolId,
  PoolPricingUsdPer1M,
  PoolSnapshot,
  ProjectUsageSummary,
  SmartRecommendation,
  TimelinePoint,
  TokenTotals,
  ToolUsageSummary,
  UsageEvent,
  UsageSnapshot,
  WindowKind,
} from './types.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const CONTEXT_BLOAT_THRESHOLD = 200_000;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function createEmptyCost(): CostBreakdown {
  return {
    estimatedApiCostUsd: 0,
    withoutCacheCostUsd: 0,
    cacheSavingsUsd: 0,
  };
}

export function createEmptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    weightedTokens: 0,
    cacheHitRate: 0,
    savedByCacheTokens: 0,
    turns: 0,
    toolCalls: 0,
    cost: createEmptyCost(),
  };
}

export function aggregateTokens(
  events: UsageEvent[],
  cacheReadWeight = 0.1,
  pricing: Record<PoolId, PoolPricingUsdPer1M> = DEFAULT_PRICING,
): TokenTotals {
  if (events.length === 0) return createEmptyTotals();
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let weightedTokens = 0;
  let toolCalls = 0;
  let estimatedApiCostUsd = 0;
  let withoutCacheCostUsd = 0;

  for (const ev of events) {
    inputTokens += ev.inputTokens;
    cacheReadTokens += ev.cacheReadTokens;
    outputTokens += ev.outputTokens;
    totalTokens += ev.totalTokens;
    weightedTokens += ev.weightedTokens;
    toolCalls += ev.toolNames.length;

    const p = pricing[ev.poolId] ?? DEFAULT_PRICING['gemini-pro'];
    const netCost =
      (ev.inputTokens / 1_000_000) * p.inputPer1M +
      (ev.cacheReadTokens / 1_000_000) * p.cacheReadPer1M +
      (ev.outputTokens / 1_000_000) * p.outputPer1M;
    const noCacheCost =
      ((ev.inputTokens + ev.cacheReadTokens) / 1_000_000) * p.inputPer1M +
      (ev.outputTokens / 1_000_000) * p.outputPer1M;
    estimatedApiCostUsd += netCost;
    withoutCacheCostUsd += noCacheCost;
  }

  const totalPromptTokens = inputTokens + cacheReadTokens;
  const cacheHitRate = totalPromptTokens > 0 ? round1((cacheReadTokens / totalPromptTokens) * 100) : 0;
  const savedByCacheTokens = Math.round(cacheReadTokens * (1 - cacheReadWeight));
  const cacheSavingsUsd = Math.max(0, withoutCacheCostUsd - estimatedApiCostUsd);

  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    weightedTokens,
    cacheHitRate,
    savedByCacheTokens,
    turns: events.length,
    toolCalls,
    cost: {
      estimatedApiCostUsd: round4(estimatedApiCostUsd),
      withoutCacheCostUsd: round4(withoutCacheCostUsd),
      cacheSavingsUsd: round4(cacheSavingsUsd),
    },
  };
}

export function getWindowDurationMs(config: MonitorConfig, windowKind: WindowKind): number {
  return windowKind === 'short'
    ? config.shortWindowMinutes * MS_PER_MINUTE
    : config.weeklyWindowHours * MS_PER_HOUR;
}

export function getDefaultTokensPerPct(
  config: MonitorConfig,
  poolId: PoolId,
  windowKind: WindowKind,
): number {
  const budgets = config.poolBudgets[poolId];
  const totalBudget =
    windowKind === 'short' ? budgets.shortWeightedTokens : budgets.weeklyWeightedTokens;
  return Math.max(100, totalBudget / 100);
}

export function resolveWindowBounds(
  events: UsageEvent[],
  windowDurationMs: number,
  nowMs: number,
  calibration?: CalibrationAnchor,
): { windowStartMs: number; nextResetAtMs: number; anchorActive: boolean } {
  if (calibration && calibration.nextResetAtMs > nowMs) {
    const nextResetAtMs = calibration.nextResetAtMs;
    const windowStartMs = nextResetAtMs - windowDurationMs;
    return { windowStartMs, nextResetAtMs, anchorActive: true };
  }

  const lookbackStart = nowMs - windowDurationMs;
  const inLookback = events.filter((e) => e.timestampMs >= lookbackStart && e.timestampMs <= nowMs);
  if (inLookback.length > 0) {
    const firstTs = inLookback[0].timestampMs;
    return {
      windowStartMs: firstTs,
      nextResetAtMs: firstTs + windowDurationMs,
      anchorActive: false,
    };
  }

  return {
    windowStartMs: nowMs,
    nextResetAtMs: nowMs + windowDurationMs,
    anchorActive: false,
  };
}

export function computeBurnRate(
  windowEvents: UsageEvent[],
  windowStartMs: number,
  nowMs: number,
  tokensPerPct: number,
  config: MonitorConfig,
  windowKind: WindowKind = 'short',
): BurnRateEstimate {
  if (windowEvents.length === 0) {
    return {
      recentPctPerHour: 0,
      ewmaPctPerHour: 0,
      windowAvgPctPerHour: 0,
      blendedPctPerHour: 0,
      rawActivePctPerHour: 0,
      decayFactor: 0,
      effectiveDutyCycle: 0,
      observedDutyCycle: 0,
      stdDevPctPerHour: 0,
      activeMinutesInWindow: 0,
      elapsedMinutesInWindow: 0,
      idleMinutesSinceLastEvent: 0,
      tokensPerMinute: 0,
      weightedTokensPerMinute: 0,
    };
  }

  const bucketMs = Math.max(1, config.bucketMinutes) * MS_PER_MINUTE;
  const recentMs = Math.max(5, config.recentMinutes) * MS_PER_MINUTE;
  const firstEventMs = windowEvents[0].timestampMs;
  const lastEventMs = windowEvents[windowEvents.length - 1].timestampMs;

  const spanStartMs = Math.max(windowStartMs, firstEventMs);
  const elapsedMs = Math.max(bucketMs, nowMs - spanStartMs);
  const elapsedMinutesInWindow = round1(elapsedMs / MS_PER_MINUTE);
  const idleMs = Math.max(0, nowMs - lastEventMs);
  const idleMinutesSinceLastEvent = round1(idleMs / MS_PER_MINUTE);

  const bucketCount = Math.max(1, Math.ceil(elapsedMs / bucketMs));
  const bucketWeighted = new Array<number>(bucketCount).fill(0);

  let totalWeightedInWindow = 0;
  let totalRawTokensInWindow = 0;
  let recentWeighted = 0;
  let recentRawTokens = 0;
  const recentCutoff = nowMs - recentMs;

  for (const ev of windowEvents) {
    totalWeightedInWindow += ev.weightedTokens;
    totalRawTokensInWindow += ev.totalTokens;
    if (ev.timestampMs >= recentCutoff) {
      recentWeighted += ev.weightedTokens;
      recentRawTokens += ev.totalTokens;
    }
    const idx = clamp(
      Math.floor((ev.timestampMs - spanStartMs) / bucketMs),
      0,
      bucketCount - 1,
    );
    bucketWeighted[idx] += ev.weightedTokens;
  }

  const bucketHours = bucketMs / MS_PER_HOUR;
  const bucketRatesPctPerHour = bucketWeighted.map((w) => w / tokensPerPct / bucketHours);
  const activeBucketRates = bucketRatesPctPerHour.filter((r) => r > 0);
  const activeMinutesInWindow = round1(
    Math.min(elapsedMinutesInWindow, activeBucketRates.length * config.bucketMinutes),
  );

  const effectiveRecentHours = Math.max(
    bucketHours,
    Math.min(recentMs, elapsedMs) / MS_PER_HOUR,
  );
  const recentPctPerHour = recentWeighted / tokensPerPct / effectiveRecentHours;

  const alpha = clamp(config.ewmaAlpha, 0.05, 0.9);
  let ewmaActive = activeBucketRates[0] ?? 0;
  for (let i = 1; i < activeBucketRates.length; i++) {
    ewmaActive = alpha * activeBucketRates[i] + (1 - alpha) * ewmaActive;
  }

  const windowElapsedHours = Math.max(bucketHours, elapsedMs / MS_PER_HOUR);
  const windowAvgPctPerHour = totalWeightedInWindow / tokensPerPct / windowElapsedHours;

  const rawActivePctPerHour =
    0.65 * ewmaActive + 0.35 * Math.max(recentPctPerHour, ewmaActive * 0.5);

  const observedDutyCycle = clamp(
    activeMinutesInWindow / Math.max(config.bucketMinutes, elapsedMinutesInWindow),
    0.02,
    1.0,
  );
  const dutyCyclePrior =
    windowKind === 'weekly'
      ? clamp((config.dutyCyclePrior ?? 0.45) * 0.35, 0.08, 0.4)
      : clamp(config.dutyCyclePrior ?? 0.45, 0.15, 1.0);
  const priorWeightMinutes = windowKind === 'weekly' ? 720 : 45;
  const effectiveDutyCycle = clamp(
    (activeMinutesInWindow + priorWeightMinutes * dutyCyclePrior) /
      (elapsedMinutesInWindow + priorWeightMinutes),
    0.05,
    1.0,
  );

  const halfLifeMin = Math.max(10, config.idleDecayHalfLifeMinutes);
  const effectiveIdleMin = Math.max(0, idleMinutesSinceLastEvent - 15);
  const decayFactor =
    effectiveIdleMin <= 0 ? 1 : Math.pow(0.5, effectiveIdleMin / halfLifeMin);

  const blendedPctPerHour = rawActivePctPerHour * effectiveDutyCycle * decayFactor;

  let stdDevPctPerHour = 0;
  if (activeBucketRates.length >= 2) {
    const mean =
      activeBucketRates.reduce((acc, v) => acc + v, 0) / activeBucketRates.length;
    const variance =
      activeBucketRates.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) /
      (activeBucketRates.length - 1);
    stdDevPctPerHour = Math.sqrt(variance) * effectiveDutyCycle;
  } else {
    stdDevPctPerHour = blendedPctPerHour * 0.35;
  }

  const effectiveRecentMin = Math.max(1, Math.min(config.recentMinutes, elapsedMinutesInWindow));
  const tokensPerMinute = Math.round(
    recentRawTokens > 0
      ? recentRawTokens / effectiveRecentMin
      : totalRawTokensInWindow / Math.max(1, elapsedMinutesInWindow),
  );
  const weightedTokensPerMinute = Math.round(
    recentWeighted > 0
      ? recentWeighted / effectiveRecentMin
      : totalWeightedInWindow / Math.max(1, elapsedMinutesInWindow),
  );

  return {
    recentPctPerHour: round2(recentPctPerHour),
    ewmaPctPerHour: round2(ewmaActive),
    windowAvgPctPerHour: round2(windowAvgPctPerHour),
    blendedPctPerHour: round2(blendedPctPerHour),
    rawActivePctPerHour: round2(rawActivePctPerHour),
    decayFactor: round2(decayFactor),
    effectiveDutyCycle: round2(effectiveDutyCycle),
    observedDutyCycle: round2(observedDutyCycle),
    stdDevPctPerHour: round2(stdDevPctPerHour),
    activeMinutesInWindow,
    elapsedMinutesInWindow,
    idleMinutesSinceLastEvent,
    tokensPerMinute,
    weightedTokensPerMinute,
  };
}

export function classifyHealthStatus(
  currentRemainingPct: number,
  predictedRemainingPctAtReset: number,
  config: MonitorConfig,
): HealthStatus {
  if (currentRemainingPct <= 0.5) return 'exhausted';
  if (
    currentRemainingPct <= config.alerts.criticalRemainingPct ||
    predictedRemainingPctAtReset <= 0.5
  ) {
    return 'critical';
  }
  if (
    currentRemainingPct <= config.alerts.warningRemainingPct ||
    predictedRemainingPctAtReset <= config.alerts.criticalRemainingPct
  ) {
    return 'warning';
  }
  if (predictedRemainingPctAtReset <= config.alerts.warningRemainingPct) {
    return 'caution';
  }
  return 'healthy';
}

export function computeWindowForecast(
  poolEvents: UsageEvent[],
  poolId: PoolId,
  windowKind: WindowKind,
  nowMs: number,
  config: MonitorConfig,
  calibration?: CalibrationAnchor,
): { forecast: ForecastResult; burnRate: BurnRateEstimate; windowEvents: UsageEvent[] } {
  const windowDurationMs = getWindowDurationMs(config, windowKind);
  const { windowStartMs, nextResetAtMs, anchorActive } = resolveWindowBounds(
    poolEvents,
    windowDurationMs,
    nowMs,
    calibration,
  );

  const windowEvents = poolEvents.filter(
    (e) => e.timestampMs >= windowStartMs && e.timestampMs <= nowMs,
  );

  const tokensPerPct =
    calibration?.learnedTokensPerPct ?? getDefaultTokensPerPct(config, poolId, windowKind);

  let currentRemainingPct: number;
  if (anchorActive && calibration) {
    const weightedSinceCalibration = windowEvents
      .filter((e) => e.timestampMs > calibration.calibratedAtMs)
      .reduce((acc, e) => acc + e.weightedTokens, 0);
    const pctDeltaSinceCal = weightedSinceCalibration / tokensPerPct;
    currentRemainingPct = clamp(calibration.remainingPct - pctDeltaSinceCal, 0, 100);
  } else {
    const windowWeighted = windowEvents.reduce((acc, e) => acc + e.weightedTokens, 0);
    const usedPct = windowWeighted / tokensPerPct;
    currentRemainingPct = clamp(100 - usedPct, 0, 100);
  }

  const currentUsedPct = round1(100 - currentRemainingPct);
  const burnRate = computeBurnRate(
    windowEvents,
    windowStartMs,
    nowMs,
    tokensPerPct,
    config,
    windowKind,
  );

  const timeToResetMs = Math.max(0, nextResetAtMs - nowMs);
  const hoursToReset = timeToResetMs / MS_PER_HOUR;

  const expectedBurn = burnRate.blendedPctPerHour * hoursToReset;
  const optimisticRate = Math.max(0, burnRate.blendedPctPerHour - 0.8 * burnRate.stdDevPctPerHour);
  const conservativeRate =
    burnRate.blendedPctPerHour + Math.max(burnRate.stdDevPctPerHour, burnRate.blendedPctPerHour * 0.25);

  const predictedExpected = round1(clamp(currentRemainingPct - expectedBurn, 0, 100));
  const predictedOptimistic = round1(
    clamp(currentRemainingPct - optimisticRate * hoursToReset, 0, 100),
  );
  const predictedConservative = round1(
    clamp(currentRemainingPct - conservativeRate * hoursToReset, 0, 100),
  );
  const activePacePredicted = round1(
    clamp(currentRemainingPct - burnRate.rawActivePctPerHour * hoursToReset, 0, 100),
  );

  let estimatedExhaustionAtMs: number | null = null;
  let runwayMinutes: number | null = null;
  let projectedLockoutMinutes: number | null = null;

  if (currentRemainingPct <= 0) {
    estimatedExhaustionAtMs = nowMs;
    runwayMinutes = 0;
    projectedLockoutMinutes = Math.round(timeToResetMs / MS_PER_MINUTE);
  } else if (burnRate.blendedPctPerHour > 0.05) {
    const hoursUntilEmpty = currentRemainingPct / burnRate.blendedPctPerHour;
    runwayMinutes = Math.round(hoursUntilEmpty * 60);
    estimatedExhaustionAtMs = Math.round(nowMs + hoursUntilEmpty * MS_PER_HOUR);
    if (estimatedExhaustionAtMs < nextResetAtMs) {
      projectedLockoutMinutes = Math.round((nextResetAtMs - estimatedExhaustionAtMs) / MS_PER_MINUTE);
    } else {
      projectedLockoutMinutes = 0;
    }
  }

  const safeAvailablePct = Math.max(0, currentRemainingPct - config.safetyBufferPct);
  const safeBurnRatePctPerHour =
    hoursToReset > 0.01 ? round2(safeAvailablePct / hoursToReset) : 100;
  const safeTokensPerMinute =
    hoursToReset > 0.01
      ? Math.round((safeAvailablePct * tokensPerPct) / (hoursToReset * 60))
      : Math.round(tokensPerPct * 10);

  const status = classifyHealthStatus(currentRemainingPct, predictedExpected, config);

  let confidence: ConfidenceLevel = 'low';
  if (anchorActive && (calibration?.sampleCount ?? 0) >= 2 && windowEvents.length >= 4) {
    confidence = 'high';
  } else if (anchorActive || (windowEvents.length >= 6 && burnRate.elapsedMinutesInWindow >= 30)) {
    confidence = 'medium';
  }

  return {
    forecast: {
      windowKind,
      windowStartMs,
      windowDurationMs,
      currentRemainingPct: round1(currentRemainingPct),
      currentUsedPct,
      predictedRemainingPctAtReset: predictedExpected,
      predictedRange: {
        optimistic: predictedOptimistic,
        expected: predictedExpected,
        conservative: predictedConservative,
      },
      activePacePredictedRemainingPct: activePacePredicted,
      nextResetAtMs,
      nextResetAtIso: new Date(nextResetAtMs).toISOString(),
      timeToResetMs,
      estimatedExhaustionAtMs,
      runwayMinutes,
      projectedLockoutMinutes,
      safeBurnRatePctPerHour,
      safeTokensPerMinute,
      status,
      confidence,
      calibrated: anchorActive,
      tokensPerPct: Math.round(tokensPerPct),
    },
    burnRate,
    windowEvents,
  };
}

function formatShortTime(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatDateKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildTimeline(
  windowEvents: UsageEvent[],
  forecast: ForecastResult,
  burnRate: BurnRateEstimate,
  nowMs: number,
): TimelinePoint[] {
  const points: TimelinePoint[] = [];
  const startMs = forecast.windowStartMs;
  const endMs = forecast.nextResetAtMs;
  const historySpan = Math.max(MS_PER_MINUTE, nowMs - startMs);
  const historySteps = 12;
  const stepMs = historySpan / historySteps;

  const totalWindowWeighted = windowEvents.reduce((acc, e) => acc + e.weightedTokens, 0);
  const startRemainingPct = clamp(
    forecast.currentRemainingPct + totalWindowWeighted / forecast.tokensPerPct,
    forecast.currentRemainingPct,
    100,
  );

  for (let i = 0; i <= historySteps; i++) {
    const t = Math.round(startMs + i * stepMs);
    const prevT = i === 0 ? startMs - 1 : Math.round(startMs + (i - 1) * stepMs);
    const cumWeighted = windowEvents
      .filter((e) => e.timestampMs <= t)
      .reduce((acc, e) => acc + e.weightedTokens, 0);
    const bucketWeighted = windowEvents
      .filter((e) => e.timestampMs > prevT && e.timestampMs <= t)
      .reduce((acc, e) => acc + e.weightedTokens, 0);
    const rem =
      i === historySteps
        ? forecast.currentRemainingPct
        : round1(clamp(startRemainingPct - cumWeighted / forecast.tokensPerPct, 0, 100));

    points.push({
      timestampMs: t,
      label: formatShortTime(t),
      remainingPct: rem,
      weightedTokens: bucketWeighted,
      projected: false,
    });
  }

  const futureSpan = Math.max(0, endMs - nowMs);
  const futureSteps = 8;
  const optimisticRate = Math.max(0, burnRate.blendedPctPerHour - 0.8 * burnRate.stdDevPctPerHour);
  const conservativeRate =
    burnRate.blendedPctPerHour + Math.max(burnRate.stdDevPctPerHour, burnRate.blendedPctPerHour * 0.25);

  if (futureSpan > 0) {
    for (let i = 1; i <= futureSteps; i++) {
      const frac = i / futureSteps;
      const t = Math.round(nowMs + futureSpan * frac);
      const hrs = (t - nowMs) / MS_PER_HOUR;
      const expected = round1(
        clamp(forecast.currentRemainingPct - burnRate.blendedPctPerHour * hrs, 0, 100),
      );
      const opt = round1(clamp(forecast.currentRemainingPct - optimisticRate * hrs, 0, 100));
      const cons = round1(clamp(forecast.currentRemainingPct - conservativeRate * hrs, 0, 100));

      points.push({
        timestampMs: t,
        label: formatShortTime(t),
        remainingPct: expected,
        weightedTokens: 0,
        projected: true,
        optimisticPct: opt,
        conservativePct: cons,
      });
    }
  }

  return points;
}

export function buildHourlyTrend24h(events: UsageEvent[], nowMs: number): HourlyBucket[] {
  const currentHourDate = new Date(nowMs);
  currentHourDate.setMinutes(0, 0, 0);
  const currentHourStart = currentHourDate.getTime();
  const firstHourStart = currentHourStart - 23 * MS_PER_HOUR;

  const buckets: HourlyBucket[] = [];
  for (let i = 0; i < 24; i++) {
    const start = firstHourStart + i * MS_PER_HOUR;
    const d = new Date(start);
    buckets.push({
      hourStartMs: start,
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      totalTokens: 0,
      weightedTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      turns: 0,
    });
  }

  for (const ev of events) {
    if (ev.timestampMs < firstHourStart || ev.timestampMs > nowMs) continue;
    const idx = clamp(Math.floor((ev.timestampMs - firstHourStart) / MS_PER_HOUR), 0, 23);
    const b = buckets[idx];
    b.totalTokens += ev.totalTokens;
    b.weightedTokens += ev.weightedTokens;
    b.inputTokens += ev.inputTokens;
    b.cacheReadTokens += ev.cacheReadTokens;
    b.outputTokens += ev.outputTokens;
    b.turns += 1;
  }

  return buckets;
}

export function buildDailyTrend7d(
  events: UsageEvent[],
  nowMs: number,
  config: MonitorConfig,
): DailyBucket[] {
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const firstDayStart = todayStart.getTime() - 6 * MS_PER_DAY;

  const map = new Map<string, UsageEvent[]>();
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const key = formatDateKey(firstDayStart + i * MS_PER_DAY);
    keys.push(key);
    map.set(key, []);
  }

  for (const ev of events) {
    if (ev.timestampMs < firstDayStart || ev.timestampMs > nowMs) continue;
    const key = formatDateKey(ev.timestampMs);
    const arr = map.get(key);
    if (arr) arr.push(ev);
  }

  return keys.map((dateKey) => {
    const dayEvents = map.get(dateKey) ?? [];
    const totals = aggregateTokens(dayEvents, config.weights.cacheReadWeight, config.pricing);
    return {
      dateKey,
      totalTokens: totals.totalTokens,
      weightedTokens: totals.weightedTokens,
      cacheHitRate: totals.cacheHitRate,
      turns: totals.turns,
      toolCalls: totals.toolCalls,
      estimatedApiCostUsd: totals.cost.estimatedApiCostUsd,
    };
  });
}

export function buildSmartRecommendations(
  pools: PoolSnapshot[],
  primaryPool: PoolSnapshot,
  allTime: TokenTotals,
  conversations: ConversationSummary[],
): SmartRecommendation[] {
  const recs: SmartRecommendation[] = [];
  const f = primaryPool.shortWindow;
  const flashPool = pools.find((p) => p.poolId === 'gemini-flash');

  if (f.projectedLockoutMinutes && f.projectedLockoutMinutes > 0) {
    recs.push({
      id: 'lockout-risk',
      severity: 'critical',
      title: '预计在刷新前触底，建议立即降速或分流',
      detail: `按当前占空比节奏（${primaryPool.burnRate.blendedPctPerHour.toFixed(1)}%/h），${primaryPool.displayName} 可能提前断档约 ${f.projectedLockoutMinutes} 分钟。建议将日常查询/轻量重构切至 Gemini Flash${flashPool ? `（当前余量 ${flashPool.shortWindow.currentRemainingPct.toFixed(0)}%）` : ''}，或将节奏控制在 ≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h。`,
    });
  } else if (f.status === 'warning' || f.status === 'caution') {
    recs.push({
      id: 'pace-caution',
      severity: 'warning',
      title: '短窗余量偏紧，留意节奏预算',
      detail: `下次刷新预计余量 ${f.predictedRemainingPctAtReset.toFixed(1)}%（安全节奏 ≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h）。复杂探索可优先复用已有会话以保持 Prompt Cache 命中。`,
    });
  }

  if (
    primaryPool.weeklyWindow.currentUsedPct >= 60 ||
    (primaryPool.weeklyWindow.currentUsedPct >= 25 &&
      primaryPool.weeklyWindow.predictedRemainingPctAtReset < 20)
  ) {
    recs.push({
      id: 'weekly-cap',
      severity: 'warning',
      title: '注意 7 天周度基线配额压力',
      detail: `${primaryPool.displayName} 周度窗口已使用 ${primaryPool.weeklyWindow.currentUsedPct.toFixed(1)}%，触及周上限可能触发多日冷却。`,
    });
  }

  const bloated = conversations.find((c) => c.contextBloatRisk);
  if (bloated) {
    recs.push({
      id: 'context-bloat',
      severity: 'warning',
      title: `检测到上下文膨胀会话（单轮峰值 ${(bloated.peakContextTokens / 1000).toFixed(0)}K）`,
      detail: `会话「${bloated.title.slice(0, 28)}」单轮提示词已超过 200K tokens。建议在对话中运行 /compact 压缩上下文或拆分新对话，可立竿见影降低单轮额度消耗。`,
    });
  }

  if (!f.calibrated && primaryPool.shortTokens.turns > 0) {
    recs.push({
      id: 'calibrate-hint',
      severity: 'info',
      title: '尚未对齐原生 /usage 锚点',
      detail:
        '当前余量基于套餐预设估算。在 Antigravity 中输入 /usage 或打开 Settings → Models，填入当前余量 % 与刷新倒计时，即可实现精准追踪；同周期校准 2 次还将自动学习你的真实 Token 换算系数。',
    });
  }

  if (allTime.turns >= 5) {
    if (allTime.cacheHitRate >= 75) {
      recs.push({
        id: 'cache-great',
        severity: 'info',
        title: `Prompt Cache 效率优秀（${allTime.cacheHitRate.toFixed(1)}%，省下 $${allTime.cost.cacheSavingsUsd.toFixed(2)}）`,
        detail: `缓存已累计帮你节省约 ${allTime.savedByCacheTokens.toLocaleString()} 个等效输入 Token（等效 API 费用节省约 $${allTime.cost.cacheSavingsUsd.toFixed(2)} USD）。`,
      });
    } else if (allTime.cacheHitRate < 45) {
      recs.push({
        id: 'cache-low',
        severity: 'warning',
        title: `Prompt Cache 命中率偏低（${allTime.cacheHitRate.toFixed(1)}%）`,
        detail: '频繁开新会话或大段改动上下文会降低缓存复用率。同类任务尽量在连续会话中推进，可明显降低额度消耗。',
      });
    }
  }

  return recs.slice(0, 4);
}

export function buildCalibrationAccuracy(
  history: CalibrationHistoryEntry[],
): CalibrationAccuracySummary {
  const recentRecords = history.slice(-20).reverse();
  if (history.length === 0) {
    return {
      totalCalibrations: 0,
      meanAbsoluteErrorPct: null,
      recentRecords: [],
    };
  }
  const sumErr = history.reduce((acc, h) => acc + h.absoluteErrorPct, 0);
  return {
    totalCalibrations: history.length,
    meanAbsoluteErrorPct: round2(sumErr / history.length),
    recentRecords,
  };
}

/**
 * Applies user calibration from Antigravity's native /usage or Settings -> Models.
 * Records accuracy error before updating and refines tokensPerPct on same-window pairs.
 */
export function applyCalibration(
  state: PersistentState,
  events: UsageEvent[],
  input: CalibrationInput,
  nowMs: number = Date.now(),
): {
  anchor: CalibrationAnchor;
  learnedUpdated: boolean;
  previousTokensPerPct: number;
  newTokensPerPct: number;
  predictedPctBefore: number;
  absoluteErrorPct: number;
} {
  const windowKind: WindowKind = input.windowKind ?? 'short';
  const remainingPct = round1(clamp(input.remainingPct, 0, 100));
  const windowDurationMs = getWindowDurationMs(state.config, windowKind);

  let nextResetAtMs: number;
  if (input.nextResetAtIso) {
    const parsed = Date.parse(input.nextResetAtIso);
    nextResetAtMs = Number.isFinite(parsed) && parsed > nowMs ? parsed : nowMs + windowDurationMs;
  } else if (
    typeof input.resetInMinutes === 'number' &&
    Number.isFinite(input.resetInMinutes) &&
    input.resetInMinutes > 0
  ) {
    nextResetAtMs = Math.round(nowMs + input.resetInMinutes * MS_PER_MINUTE);
  } else {
    nextResetAtMs = nowMs + windowDurationMs;
  }

  const key = calibrationKey(input.poolId, windowKind);
  const prev = state.calibrations[key];
  const poolEvents = events.filter((e) => e.poolId === input.poolId && e.timestampMs <= nowMs);

  // Measure our model's predicted remaining % right BEFORE applying this calibration
  const priorEval = computeWindowForecast(
    poolEvents,
    input.poolId,
    windowKind,
    nowMs,
    state.config,
    prev,
  );
  const predictedPctBefore = priorEval.forecast.currentRemainingPct;
  const absoluteErrorPct = round1(Math.abs(predictedPctBefore - remainingPct));

  const defaultTpp = getDefaultTokensPerPct(state.config, input.poolId, windowKind);
  const previousTokensPerPct = prev?.learnedTokensPerPct ?? defaultTpp;
  const cumulativeWeighted = poolEvents.reduce((acc, e) => acc + e.weightedTokens, 0);

  let learnedTokensPerPct = prev?.learnedTokensPerPct;
  let learnedUpdated = false;
  let sampleCount = (prev?.sampleCount ?? 0) + 1;

  if (
    prev &&
    Math.abs(prev.nextResetAtMs - nextResetAtMs) <= 20 * MS_PER_MINUTE &&
    nowMs > prev.calibratedAtMs
  ) {
    const deltaPct = prev.remainingPct - remainingPct;
    const deltaWeighted = cumulativeWeighted - prev.cumulativeWeightedAtCalibration;
    if (deltaPct >= 2 && deltaWeighted > 0) {
      const observedTpp = deltaWeighted / deltaPct;
      const minBound = defaultTpp * 0.1;
      const maxBound = defaultTpp * 10;
      const clampedObserved = clamp(observedTpp, minBound, maxBound);
      learnedTokensPerPct = Math.round(0.6 * clampedObserved + 0.4 * previousTokensPerPct);
      learnedUpdated = true;
    }
  } else if (!prev) {
    sampleCount = 1;
  }

  const anchor: CalibrationAnchor = {
    poolId: input.poolId,
    windowKind,
    remainingPct,
    nextResetAtMs,
    calibratedAtMs: nowMs,
    cumulativeWeightedAtCalibration: cumulativeWeighted,
    learnedTokensPerPct,
    sampleCount,
  };

  state.calibrations[key] = anchor;
  if (!Array.isArray(state.calibrationHistory)) {
    state.calibrationHistory = [];
  }
  state.calibrationHistory.push({
    timestampMs: nowMs,
    timestampIso: new Date(nowMs).toISOString(),
    poolId: input.poolId,
    windowKind,
    predictedPctBefore,
    actualPct: remainingPct,
    absoluteErrorPct,
    tokensPerPctAfter: Math.round(learnedTokensPerPct ?? defaultTpp),
    learnedUpdated,
  });
  if (state.calibrationHistory.length > 50) {
    state.calibrationHistory = state.calibrationHistory.slice(-50);
  }

  return {
    anchor,
    learnedUpdated,
    previousTokensPerPct: Math.round(previousTokensPerPct),
    newTokensPerPct: Math.round(learnedTokensPerPct ?? defaultTpp),
    predictedPctBefore,
    absoluteErrorPct,
  };
}

function getTodayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildUsageSnapshot(
  events: UsageEvent[],
  conversationsMap: Map<string, ConversationMeta>,
  state: PersistentState,
  scannedFilesCount: number,
  nowMs: number = Date.now(),
): UsageSnapshot {
  const { config } = state;
  const cacheW = config.weights.cacheReadWeight;
  const pricing = config.pricing ?? DEFAULT_PRICING;
  const todayStartMs = getTodayStartMs(nowMs);
  const shortCutoff = nowMs - getWindowDurationMs(config, 'short');
  const weeklyCutoff = nowMs - getWindowDurationMs(config, 'weekly');

  const pools: PoolSnapshot[] = ALL_POOLS.map((poolId) => {
    const poolEvents = events.filter((e) => e.poolId === poolId);
    const shortCal = state.calibrations[calibrationKey(poolId, 'short')];
    const weeklyCal = state.calibrations[calibrationKey(poolId, 'weekly')];

    const shortRes = computeWindowForecast(poolEvents, poolId, 'short', nowMs, config, shortCal);
    const weeklyRes = computeWindowForecast(poolEvents, poolId, 'weekly', nowMs, config, weeklyCal);

    const modelsSet = new Set<string>();
    for (const ev of poolEvents) modelsSet.add(ev.model);

    const timeline = buildTimeline(shortRes.windowEvents, shortRes.forecast, shortRes.burnRate, nowMs);

    return {
      poolId,
      displayName: POOL_DISPLAY_NAMES[poolId],
      models: Array.from(modelsSet).sort(),
      shortWindow: shortRes.forecast,
      weeklyWindow: weeklyRes.forecast,
      shortTokens: aggregateTokens(shortRes.windowEvents, cacheW, pricing),
      weeklyTokens: aggregateTokens(weeklyRes.windowEvents, cacheW, pricing),
      allTimeTokens: aggregateTokens(poolEvents, cacheW, pricing),
      burnRate: shortRes.burnRate,
      calibration: shortCal && shortCal.nextResetAtMs > nowMs ? shortCal : undefined,
      weeklyCalibration: weeklyCal && weeklyCal.nextResetAtMs > nowMs ? weeklyCal : undefined,
      timeline,
    };
  });

  const activePools = pools.filter(
    (p) => p.shortTokens.turns > 0 || p.calibration !== undefined || p.allTimeTokens.turns > 0,
  );
  let primaryPool = pools[0];
  if (activePools.length > 0) {
    primaryPool = [...activePools].sort((a, b) => {
      if (a.shortWindow.predictedRemainingPctAtReset !== b.shortWindow.predictedRemainingPctAtReset) {
        return a.shortWindow.predictedRemainingPctAtReset - b.shortWindow.predictedRemainingPctAtReset;
      }
      return b.shortTokens.weightedTokens - a.shortTokens.weightedTokens;
    })[0];
  }

  const allTime = aggregateTokens(events, cacheW, pricing);
  const today = aggregateTokens(
    events.filter((e) => e.timestampMs >= todayStartMs && e.timestampMs <= nowMs),
    cacheW,
    pricing,
  );
  const shortWindowTotals = aggregateTokens(
    events.filter((e) => e.timestampMs >= shortCutoff && e.timestampMs <= nowMs),
    cacheW,
    pricing,
  );
  const weeklyWindowTotals = aggregateTokens(
    events.filter((e) => e.timestampMs >= weeklyCutoff && e.timestampMs <= nowMs),
    cacheW,
    pricing,
  );

  // Per-model breakdown
  const byModel = new Map<string, UsageEvent[]>();
  for (const ev of events) {
    const arr = byModel.get(ev.model);
    if (arr) arr.push(ev);
    else byModel.set(ev.model, [ev]);
  }
  const models: ModelBreakdownSummary[] = Array.from(byModel.entries())
    .map(([model, modelEvents]) => {
      const tokens = aggregateTokens(modelEvents, cacheW, pricing);
      return {
        model,
        poolId: modelEvents[0].poolId,
        tokens,
        shareOfAllTimePct:
          allTime.totalTokens > 0 ? round1((tokens.totalTokens / allTime.totalTokens) * 100) : 0,
      };
    })
    .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens);

  // Per-conversation breakdown (with peakContextTokens & context bloat detection)
  const byConv = new Map<string, UsageEvent[]>();
  for (const ev of events) {
    const arr = byConv.get(ev.conversationId);
    if (arr) arr.push(ev);
    else byConv.set(ev.conversationId, [ev]);
  }
  const conversations: ConversationSummary[] = Array.from(byConv.entries())
    .map(([conversationId, convEvents]) => {
      const meta = conversationsMap.get(conversationId);
      const tokens = aggregateTokens(convEvents, cacheW, pricing);
      const lastActiveMs =
        convEvents[convEvents.length - 1]?.timestampMs ?? meta?.lastTimestampMs ?? nowMs;
      const modelSet = new Set(convEvents.map((e) => e.model));
      let peakContextTokens = 0;
      for (const ev of convEvents) {
        const ctx = ev.inputTokens + ev.cacheReadTokens;
        if (ctx > peakContextTokens) peakContextTokens = ctx;
      }
      const avgTokensPerTurn =
        tokens.turns > 0 ? Math.round(tokens.totalTokens / tokens.turns) : 0;

      return {
        conversationId,
        title: meta?.title || `Session ${conversationId.slice(0, 8)}`,
        projectName: meta?.projectName || 'Default Workspace',
        surface: meta?.surface ?? convEvents[0].surface,
        models: Array.from(modelSet),
        lastActiveAt: new Date(lastActiveMs).toISOString(),
        lastActiveMs,
        tokens,
        peakContextTokens,
        avgTokensPerTurn,
        contextBloatRisk: peakContextTokens >= CONTEXT_BLOAT_THRESHOLD,
        shareOfAllTimePct:
          allTime.totalTokens > 0 ? round1((tokens.totalTokens / allTime.totalTokens) * 100) : 0,
      };
    })
    .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens);

  // Per-project aggregation
  const byProjectEvents = new Map<string, UsageEvent[]>();
  const byProjectConvCount = new Map<string, number>();
  for (const conv of conversations) {
    byProjectConvCount.set(conv.projectName, (byProjectConvCount.get(conv.projectName) ?? 0) + 1);
  }
  for (const ev of events) {
    const projectName = conversationsMap.get(ev.conversationId)?.projectName || 'Default Workspace';
    const arr = byProjectEvents.get(projectName);
    if (arr) arr.push(ev);
    else byProjectEvents.set(projectName, [ev]);
  }
  const projects: ProjectUsageSummary[] = Array.from(byProjectEvents.entries())
    .map(([projectName, projEvents]) => {
      const tokens = aggregateTokens(projEvents, cacheW, pricing);
      const modelTokens = new Map<string, number>();
      for (const ev of projEvents) {
        modelTokens.set(ev.model, (modelTokens.get(ev.model) ?? 0) + ev.totalTokens);
      }
      const topModel =
        Array.from(modelTokens.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
      return {
        projectName,
        conversationCount: byProjectConvCount.get(projectName) ?? 1,
        topModel,
        tokens,
        shareOfAllTimePct:
          allTime.totalTokens > 0 ? round1((tokens.totalTokens / allTime.totalTokens) * 100) : 0,
      };
    })
    .sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens);

  // Per-tool breakdown
  const toolCounts = new Map<string, number>();
  let totalToolCalls = 0;
  for (const ev of events) {
    for (const name of ev.toolNames) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      totalToolCalls += 1;
    }
  }
  const topTools: ToolUsageSummary[] = Array.from(toolCounts.entries())
    .map(([name, calls]) => ({
      name,
      calls,
      sharePct: totalToolCalls > 0 ? round1((calls / totalToolCalls) * 100) : 0,
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 15);

  const hourlyTrend24h = buildHourlyTrend24h(events, nowMs);
  const dailyTrend7d = buildDailyTrend7d(events, nowMs, config);
  const calibrationAccuracy = buildCalibrationAccuracy(state.calibrationHistory ?? []);
  const recommendations = buildSmartRecommendations(pools, primaryPool, allTime, conversations);

  return {
    generatedAtMs: nowMs,
    generatedAtIso: new Date(nowMs).toISOString(),
    plan: config.plan,
    primaryPoolId: primaryPool.poolId,
    overallShort: primaryPool.shortWindow,
    overallWeekly: primaryPool.weeklyWindow,
    totals: {
      allTime,
      today,
      shortWindow: shortWindowTotals,
      weeklyWindow: weeklyWindowTotals,
    },
    pools,
    models,
    projects,
    conversations,
    topTools,
    hourlyTrend24h,
    dailyTrend7d,
    calibrationAccuracy,
    recommendations,
    scannedFilesCount,
    totalEventsCount: events.length,
    config,
  };
}
