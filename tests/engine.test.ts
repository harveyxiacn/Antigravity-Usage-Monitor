import { describe, expect, it } from 'vitest';
import {
  applyCalibration,
  buildUsageSnapshot,
  computeWeightedTokens,
  createDefaultState,
  renderCsvReport,
  renderMarkdownReport,
  resolveModelPool,
  type ConversationMeta,
  type UsageEvent,
} from '../src/core/index.js';

function makeEvent(overrides: Partial<UsageEvent> & { timestampMs: number }): UsageEvent {
  const model = overrides.model ?? 'gemini-4-neon-high';
  const poolId = overrides.poolId ?? resolveModelPool(model);
  const inputTokens = overrides.inputTokens ?? 20_000;
  const cacheReadTokens = overrides.cacheReadTokens ?? 40_000;
  const outputTokens = overrides.outputTokens ?? 2_000;
  return {
    conversationId: overrides.conversationId ?? 'conv-main',
    surface: overrides.surface ?? 'antigravity',
    stepIndex: overrides.stepIndex ?? 1,
    timestampMs: overrides.timestampMs,
    createdAt: new Date(overrides.timestampMs).toISOString(),
    model,
    poolId,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    weightedTokens:
      overrides.weightedTokens ??
      computeWeightedTokens(inputTokens, cacheReadTokens, outputTokens, poolId),
    toolNames: overrides.toolNames ?? ['read_file'],
  };
}

describe('Dual-Window Quota & Forecast Engine', () => {
  it('computes total tokens, cache hit rate, and next-refresh forecast with confidence interval', () => {
    const state = createDefaultState();
    const nowMs = Date.parse('2026-11-27T10:00:00Z');
    const events: UsageEvent[] = [];

    // 12 events over the past 60 minutes (every 5 minutes)
    for (let i = 0; i < 12; i++) {
      events.push(
        makeEvent({
          stepIndex: i + 1,
          timestampMs: nowMs - (60 - i * 5) * 60_000,
          inputTokens: 15_000 + (i % 3) * 5_000,
          cacheReadTokens: 60_000,
          outputTokens: 3_000,
          toolNames: ['read_file', 'edit_file'],
        }),
      );
    }

    const convMap = new Map<string, ConversationMeta>([
      [
        'conv-main',
        {
          conversationId: 'conv-main',
          surface: 'antigravity',
          title: 'Core Monitor Build',
          projectName: 'Antigravity-Usage-Monitor',
          firstTimestampMs: events[0].timestampMs,
          lastTimestampMs: events[events.length - 1].timestampMs,
          transcriptPath: '/tmp/transcript.jsonl',
        },
      ],
    ]);

    const snapshot = buildUsageSnapshot(events, convMap, state, 1, nowMs);
    const proPool = snapshot.pools.find((p) => p.poolId === 'gemini-pro')!;

    expect(snapshot.totals.allTime.turns).toBe(12);
    expect(snapshot.totals.allTime.toolCalls).toBe(24);
    expect(snapshot.totals.allTime.cacheHitRate).toBeGreaterThan(70);
    expect(proPool.shortWindow.currentRemainingPct).toBeLessThan(100);
    expect(proPool.shortWindow.currentRemainingPct).toBeGreaterThan(50);

    // Predicted remaining at reset must be lower than current remaining given active burn
    expect(proPool.shortWindow.predictedRemainingPctAtReset).toBeLessThan(
      proPool.shortWindow.currentRemainingPct,
    );
    expect(proPool.shortWindow.predictedRange.conservative).toBeLessThanOrEqual(
      proPool.shortWindow.predictedRange.expected,
    );
    expect(proPool.shortWindow.predictedRange.expected).toBeLessThanOrEqual(
      proPool.shortWindow.predictedRange.optimistic,
    );
    expect(proPool.timeline.length).toBeGreaterThan(15);
    expect(proPool.timeline.some((p) => p.projected)).toBe(true);
  });

  it('predicts exhaustion ETA and lockout minutes when burn rate exceeds remaining budget', () => {
    const state = createDefaultState();
    state.config.plan = 'free';
    state.config.poolBudgets['gemini-pro'].shortWeightedTokens = 200_000; // 2000 weighted tokens per 1%

    const nowMs = Date.parse('2026-11-27T10:00:00Z');
    // Burn ~40% in 30 minutes => ~80%/hr with 4.5h left to reset => guaranteed exhaustion!
    const events: UsageEvent[] = [
      makeEvent({ timestampMs: nowMs - 30 * 60_000, weightedTokens: 20_000 }),
      makeEvent({ timestampMs: nowMs - 20 * 60_000, weightedTokens: 20_000 }),
      makeEvent({ timestampMs: nowMs - 10 * 60_000, weightedTokens: 20_000 }),
      makeEvent({ timestampMs: nowMs - 2 * 60_000, weightedTokens: 20_000 }),
    ];

    const snapshot = buildUsageSnapshot(events, new Map(), state, 1, nowMs);
    const f = snapshot.overallShort;

    expect(f.currentRemainingPct).toBeCloseTo(60, 0);
    expect(f.predictedRemainingPctAtReset).toBe(0);
    expect(f.runwayMinutes).not.toBeNull();
    expect(f.runwayMinutes!).toBeGreaterThan(0);
    expect(f.projectedLockoutMinutes).not.toBeNull();
    expect(f.projectedLockoutMinutes!).toBeGreaterThan(60);
    expect(f.status).toBe('critical');
  });

  it('auto-learns tokensPerPct when calibrated twice within the same refresh window', () => {
    const state = createDefaultState();
    const t0 = Date.parse('2026-11-27T08:00:00Z');
    const resetAtIso = '2026-11-27T12:00:00Z';

    const eventsBeforeT0: UsageEvent[] = [
      makeEvent({ timestampMs: t0 - 10 * 60_000, weightedTokens: 50_000 }),
    ];

    // First calibration at t0: remaining 80%, reset at 12:00
    const cal1 = applyCalibration(
      state,
      eventsBeforeT0,
      {
        poolId: 'gemini-pro',
        windowKind: 'short',
        remainingPct: 80,
        nextResetAtIso: resetAtIso,
      },
      t0,
    );
    expect(cal1.learnedUpdated).toBe(false);

    // User burns 400,000 weighted tokens over next 40 minutes and native /usage now shows 70% (-10%)
    // Observed tokensPerPct = 400,000 / 10 = 40,000 (default ai-pro was 25,000)
    const t1 = t0 + 40 * 60_000;
    const allEvents: UsageEvent[] = [
      ...eventsBeforeT0,
      makeEvent({ timestampMs: t0 + 15 * 60_000, weightedTokens: 200_000 }),
      makeEvent({ timestampMs: t0 + 35 * 60_000, weightedTokens: 200_000 }),
    ];

    const cal2 = applyCalibration(
      state,
      allEvents,
      {
        poolId: 'gemini-pro',
        windowKind: 'short',
        remainingPct: 70,
        nextResetAtIso: resetAtIso,
      },
      t1,
    );

    expect(cal2.learnedUpdated).toBe(true);
    // Expected damped update: 0.6 * 40000 + 0.4 * 25000 = 34000
    expect(cal2.newTokensPerPct).toBe(34_000);

    // Subsequent event of 34,000 weighted tokens should drop remaining from 70% to 69%
    const t2 = t1 + 5 * 60_000;
    const afterEvents = [
      ...allEvents,
      makeEvent({ timestampMs: t2, weightedTokens: 34_000 }),
    ];
    const snapshot = buildUsageSnapshot(afterEvents, new Map(), state, 1, t2);
    const pro = snapshot.pools.find((p) => p.poolId === 'gemini-pro')!;
    expect(pro.shortWindow.calibrated).toBe(true);
    expect(pro.shortWindow.currentRemainingPct).toBeCloseTo(69.0, 1);
    expect(pro.shortWindow.tokensPerPct).toBe(34_000);
    expect(snapshot.calibrationAccuracy.totalCalibrations).toBe(2);
    expect(snapshot.calibrationAccuracy.meanAbsoluteErrorPct).not.toBeNull();
  });

  it('regularizes cold-start bursts via duty-cycle prior, generates 24h/7d trends, recommendations, and Markdown/CSV reports', () => {
    const state = createDefaultState();
    const nowMs = Date.parse('2026-11-27T11:30:00Z');

    // Intense 10-minute burst (cold start)
    const events: UsageEvent[] = [
      makeEvent({ timestampMs: nowMs - 10 * 60_000, weightedTokens: 150_000 }),
      makeEvent({ timestampMs: nowMs - 5 * 60_000, weightedTokens: 150_000 }),
      makeEvent({ timestampMs: nowMs - 1 * 60_000, weightedTokens: 150_000 }),
    ];

    const snapshot = buildUsageSnapshot(events, new Map(), state, 1, nowMs);
    const pro = snapshot.pools.find((p) => p.poolId === 'gemini-pro')!;

    // Regularized blended rate should be noticeably lower than raw full-throttle active rate during a 10m burst
    expect(pro.burnRate.effectiveDutyCycle).toBeLessThan(0.75);
    expect(pro.burnRate.blendedPctPerHour).toBeLessThan(pro.burnRate.rawActivePctPerHour);
    expect(pro.shortWindow.predictedRemainingPctAtReset).toBeGreaterThanOrEqual(
      pro.shortWindow.activePacePredictedRemainingPct,
    );

    // 24h & 7d trends + smart recommendations
    expect(snapshot.hourlyTrend24h).toHaveLength(24);
    expect(snapshot.dailyTrend7d).toHaveLength(7);
    expect(snapshot.hourlyTrend24h.some((b) => b.totalTokens > 0)).toBe(true);
    expect(snapshot.recommendations.some((r) => r.id === 'calibrate-hint')).toBe(true);

    // Report renderers
    const md = renderMarkdownReport(snapshot);
    expect(md).toContain('# Antigravity Usage & Quota Forecast Report');
    expect(md).toContain('下次刷新时预告余量');
    const csv = renderCsvReport(snapshot);
    expect(csv.split('\n')[0]).toContain('conversation_id');
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(2);
  });
});
