import { describe, expect, it } from 'vitest';
import {
  buildUsageSnapshot,
  computeWeightedTokens,
  createDefaultState,
  simulateWorkload,
  type ConversationMeta,
  type UsageEvent,
} from '../src/core/index.js';

function makeEvent(ts: number, input = 30_000, cache = 180_000, output = 4_000): UsageEvent {
  return {
    conversationId: 'conv-sim',
    surface: 'antigravity',
    stepIndex: 1,
    timestampMs: ts,
    createdAt: new Date(ts).toISOString(),
    model: 'gemini-4-neon-high',
    poolId: 'gemini-pro',
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
    weightedTokens: computeWeightedTokens(input, cache, output, 'gemini-pro'),
    toolNames: ['read_file'],
  };
}

describe('What-If Workload Simulator & Cost/Project/Context Diagnostics', () => {
  it('simulates additional turns and quantifies Flash offload savings', () => {
    const state = createDefaultState();
    state.config.poolBudgets['gemini-pro'].shortWeightedTokens = 1_000_000;
    const nowMs = Date.parse('2026-11-27T12:00:00Z');

    const events = [
      makeEvent(nowMs - 20 * 60_000, 60_000, 200_000, 10_000),
      makeEvent(nowMs - 10 * 60_000, 60_000, 220_000, 10_000),
    ];
    const convs = new Map<string, ConversationMeta>([
      [
        'conv-sim',
        {
          conversationId: 'conv-sim',
          surface: 'antigravity',
          title: 'Big Refactor',
          projectName: 'Antigravity-Usage-Monitor',
          firstTimestampMs: events[0].timestampMs,
          lastTimestampMs: events[1].timestampMs,
          transcriptPath: '/tmp/t.jsonl',
        },
      ],
    ]);

    const snap = buildUsageSnapshot(events, convs, state, 1, nowMs);

    // Check API cost equivalent, project aggregation, and context bloat (>200K peak)
    expect(snap.totals.allTime.cost.estimatedApiCostUsd).toBeGreaterThan(0);
    expect(snap.totals.allTime.cost.cacheSavingsUsd).toBeGreaterThan(0);
    expect(snap.projects).toHaveLength(1);
    expect(snap.projects[0].projectName).toBe('Antigravity-Usage-Monitor');
    expect(snap.conversations[0].peakContextTokens).toBe(280_000);
    expect(snap.conversations[0].contextBloatRisk).toBe(true);
    expect(snap.recommendations.some((r) => r.id === 'context-bloat')).toBe(true);

    // Simulate +8 heavy turns with 50% offload to Flash
    const sim = simulateWorkload(snap, {
      poolId: 'gemini-pro',
      windowKind: 'short',
      additionalTurns: 8,
      offloadToFlashPct: 50,
    });

    expect(sim.simulatedAddedWeightedTokens).toBeGreaterThan(0);
    expect(sim.withOffloadRemainingPct).toBeGreaterThan(sim.remainingAfterWorkloadPct);
    expect(sim.savedPrimaryPct).toBeGreaterThan(0);
    expect(sim.flashImpactPct).toBeGreaterThan(0);
    expect(sim.flashImpactPct).toBeLessThan(sim.simulatedAddedPct);
  });
});
