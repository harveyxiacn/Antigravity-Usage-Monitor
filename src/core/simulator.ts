import { clamp, round1 } from './engine.js';
import type {
  PoolId,
  SimulationInput,
  SimulationResult,
  UsageSnapshot,
  WindowKind,
} from './types.js';

/**
 * Runs a What-If workload simulation against the current UsageSnapshot:
 * Answers "If I run N more turns / M more minutes, or offload X% to Gemini Flash,
 * how much quota will remain before next refresh?"
 */
export function simulateWorkload(
  snapshot: UsageSnapshot,
  input: SimulationInput,
): SimulationResult {
  const poolId: PoolId = input.poolId ?? snapshot.primaryPoolId;
  const windowKind: WindowKind = input.windowKind ?? 'short';
  const pool = snapshot.pools.find((p) => p.poolId === poolId) ?? snapshot.pools[0];
  const flashPool = snapshot.pools.find((p) => p.poolId === 'gemini-flash') ?? snapshot.pools[1];

  const forecast = windowKind === 'short' ? pool.shortWindow : pool.weeklyWindow;
  const flashForecast = windowKind === 'short' ? flashPool.shortWindow : flashPool.weeklyWindow;

  // Estimate average weighted tokens per turn from pool history, fallback to 35K
  const historicalAvgPerTurn =
    pool.allTimeTokens.turns > 0
      ? Math.round(pool.allTimeTokens.weightedTokens / pool.allTimeTokens.turns)
      : 35_000;
  const avgWeightedPerTurn = Math.max(
    1_000,
    Math.round(input.avgWeightedTokensPerTurn ?? historicalAvgPerTurn),
  );

  let simulatedAddedWeightedTokens = 0;
  if (typeof input.additionalTurns === 'number' && input.additionalTurns > 0) {
    simulatedAddedWeightedTokens += Math.round(input.additionalTurns * avgWeightedPerTurn);
  }
  if (typeof input.additionalMinutes === 'number' && input.additionalMinutes > 0) {
    const ratePerMin =
      pool.burnRate.weightedTokensPerMinute > 0
        ? pool.burnRate.weightedTokensPerMinute
        : Math.round(avgWeightedPerTurn / 2);
    simulatedAddedWeightedTokens += Math.round(input.additionalMinutes * ratePerMin);
  }
  if (simulatedAddedWeightedTokens === 0) {
    // Default quick check: +15 turns
    simulatedAddedWeightedTokens = 15 * avgWeightedPerTurn;
  }

  const simulatedAddedPct = round1(simulatedAddedWeightedTokens / Math.max(100, forecast.tokensPerPct));
  const baselineRemainingPct = forecast.currentRemainingPct;
  const remainingAfterWorkloadPct = round1(clamp(baselineRemainingPct - simulatedAddedPct, 0, 100));
  const survivesUntilReset = remainingAfterWorkloadPct > 0;

  // Calculate Flash offload scenario
  const offloadToFlashPct = round1(clamp(input.offloadToFlashPct ?? 0, 0, 100));
  const offloadRatio = offloadToFlashPct / 100;

  const primaryMult = snapshot.config.weights.poolMultipliers[poolId] ?? 1.0;
  const flashMult = snapshot.config.weights.poolMultipliers['gemini-flash'] ?? 0.25;
  const relativeFlashFactor = poolId === 'gemini-flash' ? 1 : flashMult / Math.max(0.05, primaryMult);

  const primaryWeightedAfterOffload = simulatedAddedWeightedTokens * (1 - offloadRatio);
  const flashWeightedAdded = simulatedAddedWeightedTokens * offloadRatio * relativeFlashFactor;

  const primaryPctAfterOffload = primaryWeightedAfterOffload / Math.max(100, forecast.tokensPerPct);
  const withOffloadRemainingPct = round1(
    clamp(baselineRemainingPct - primaryPctAfterOffload, 0, 100),
  );
  const flashImpactPct =
    poolId === 'gemini-flash'
      ? 0
      : round1(flashWeightedAdded / Math.max(100, flashForecast.tokensPerPct));
  const savedPrimaryPct = round1(Math.max(0, withOffloadRemainingPct - remainingAfterWorkloadPct));

  let recommendation: string;
  if (!survivesUntilReset && offloadToFlashPct === 0 && poolId !== 'gemini-flash') {
    const neededOffload = Math.min(
      95,
      Math.ceil((1 - baselineRemainingPct / Math.max(0.1, simulatedAddedPct)) * 100),
    );
    recommendation = `直接执行该负载将耗尽 ${pool.displayName} 额度（预计消耗 ${simulatedAddedPct}% > 当前余量 ${baselineRemainingPct}%）。建议将至少 ${neededOffload}% 的探索/读取任务分流至 Gemini Flash，或等待刷新后再执行重型任务。`;
  } else if (withOffloadRemainingPct <= snapshot.config.safetyBufferPct) {
    recommendation = `即使分流 ${offloadToFlashPct}%，剩余缓冲仍低于 ${snapshot.config.safetyBufferPct}% 安全线（预计剩 ${withOffloadRemainingPct}%），建议先执行 /compact 压缩上下文并放缓节奏。`;
  } else if (savedPrimaryPct >= 5) {
    recommendation = `分流 ${offloadToFlashPct}% 至 Flash 可为主力池节省 ${savedPrimaryPct}% 额度（最终剩余 ${withOffloadRemainingPct}%），Flash 池仅消耗约 ${flashImpactPct}%，非常划算！`;
  } else {
    recommendation = `当前额度足以安全承载该计划负载，完成后预计仍剩余 ${withOffloadRemainingPct}%。`;
  }

  return {
    poolId,
    windowKind,
    baselineRemainingPct,
    simulatedAddedWeightedTokens,
    simulatedAddedPct,
    remainingAfterWorkloadPct,
    survivesUntilReset,
    offloadToFlashPct,
    withOffloadRemainingPct,
    flashImpactPct,
    savedPrimaryPct,
    recommendation,
  };
}
