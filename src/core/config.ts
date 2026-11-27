import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  MonitorConfig,
  PersistentState,
  PlanId,
  PoolBudgets,
  PoolId,
  TokenWeights,
} from './types.js';

export const STATE_VERSION = 1;

export const POOL_DISPLAY_NAMES: Record<PoolId, string> = {
  'gemini-pro': 'Gemini Pro / Neon',
  'gemini-flash': 'Gemini Flash',
  partner: 'Partner Models (Claude / GPT)',
};

export const ALL_POOLS: PoolId[] = ['gemini-pro', 'gemini-flash', 'partner'];

export const DEFAULT_WEIGHTS: TokenWeights = {
  inputWeight: 1.0,
  cacheReadWeight: 0.1,
  outputWeight: 4.0,
  poolMultipliers: {
    'gemini-pro': 1.0,
    'gemini-flash': 0.25,
    partner: 1.25,
  },
};

export const PLAN_PRESETS: Record<PlanId, Record<PoolId, PoolBudgets>> = {
  free: {
    'gemini-pro': {
      shortWeightedTokens: 450_000,
      weeklyWeightedTokens: 2_800_000,
    },
    'gemini-flash': {
      shortWeightedTokens: 1_500_000,
      weeklyWeightedTokens: 10_000_000,
    },
    partner: {
      shortWeightedTokens: 300_000,
      weeklyWeightedTokens: 1_800_000,
    },
  },
  'ai-pro': {
    'gemini-pro': {
      shortWeightedTokens: 2_500_000,
      weeklyWeightedTokens: 25_000_000,
    },
    'gemini-flash': {
      shortWeightedTokens: 8_000_000,
      weeklyWeightedTokens: 80_000_000,
    },
    partner: {
      shortWeightedTokens: 1_800_000,
      weeklyWeightedTokens: 18_000_000,
    },
  },
  'ai-ultra': {
    'gemini-pro': {
      shortWeightedTokens: 12_000_000,
      weeklyWeightedTokens: 120_000_000,
    },
    'gemini-flash': {
      shortWeightedTokens: 40_000_000,
      weeklyWeightedTokens: 400_000_000,
    },
    partner: {
      shortWeightedTokens: 8_000_000,
      weeklyWeightedTokens: 80_000_000,
    },
  },
  custom: {
    'gemini-pro': {
      shortWeightedTokens: 2_500_000,
      weeklyWeightedTokens: 25_000_000,
    },
    'gemini-flash': {
      shortWeightedTokens: 8_000_000,
      weeklyWeightedTokens: 80_000_000,
    },
    partner: {
      shortWeightedTokens: 1_800_000,
      weeklyWeightedTokens: 18_000_000,
    },
  },
};

export function clonePoolBudgets(
  budgets: Record<PoolId, PoolBudgets>,
): Record<PoolId, PoolBudgets> {
  return {
    'gemini-pro': { ...budgets['gemini-pro'] },
    'gemini-flash': { ...budgets['gemini-flash'] },
    partner: { ...budgets.partner },
  };
}

export function createDefaultConfig(plan: PlanId = 'ai-pro'): MonitorConfig {
  return {
    plan,
    shortWindowMinutes: 300, // 5 hours
    weeklyWindowHours: 168, // 7 days
    safetyBufferPct: 5,
    ewmaAlpha: 0.35,
    bucketMinutes: 5,
    recentMinutes: 30,
    idleDecayHalfLifeMinutes: 45,
    dutyCyclePrior: 0.45,
    weights: {
      ...DEFAULT_WEIGHTS,
      poolMultipliers: { ...DEFAULT_WEIGHTS.poolMultipliers },
    },
    poolBudgets: clonePoolBudgets(PLAN_PRESETS[plan]),
    alerts: {
      enabled: true,
      warningRemainingPct: 20,
      criticalRemainingPct: 10,
      cooldownMinutes: 15,
    },
    customBrainDirs: [],
  };
}

export function resolveModelPool(modelName: string): PoolId {
  const lower = (modelName || '').toLowerCase();
  if (lower.includes('flash')) {
    return 'gemini-flash';
  }
  if (
    lower.includes('claude') ||
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('haiku') ||
    lower.includes('gpt') ||
    /\bo[134]\b/.test(lower) ||
    lower.startsWith('o1-') ||
    lower.startsWith('o3-') ||
    lower.startsWith('o4-')
  ) {
    return 'partner';
  }
  return 'gemini-pro';
}

export function computeWeightedTokens(
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  poolId: PoolId,
  weights: TokenWeights = DEFAULT_WEIGHTS,
): number {
  const mult = weights.poolMultipliers[poolId] ?? 1.0;
  const raw =
    inputTokens * weights.inputWeight +
    cacheReadTokens * weights.cacheReadWeight +
    outputTokens * weights.outputWeight;
  return Math.max(0, Math.round(raw * mult));
}

export function getDefaultDataDir(): string {
  if (process.env.AGY_USAGE_DATA_DIR && process.env.AGY_USAGE_DATA_DIR.trim()) {
    return process.env.AGY_USAGE_DATA_DIR.trim();
  }
  if (process.env.PLUGIN_DATA && process.env.PLUGIN_DATA.trim()) {
    return process.env.PLUGIN_DATA.trim();
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-usage-monitor');
}

export function getStateFilePath(dataDir?: string): string {
  return path.join(dataDir ?? getDefaultDataDir(), 'state.json');
}

export function createDefaultState(): PersistentState {
  return {
    version: STATE_VERSION,
    config: createDefaultConfig('ai-pro'),
    calibrations: {},
    scanCache: {},
    lastAlertAtMs: {},
  };
}

export function mergeConfig(
  base: MonitorConfig,
  patch: Partial<MonitorConfig>,
): MonitorConfig {
  const nextPlan = patch.plan ?? base.plan;
  let nextBudgets = clonePoolBudgets(base.poolBudgets);
  if (patch.plan && patch.plan !== base.plan && patch.plan !== 'custom') {
    nextBudgets = clonePoolBudgets(PLAN_PRESETS[patch.plan]);
  }
  if (patch.poolBudgets) {
    for (const poolId of ALL_POOLS) {
      if (patch.poolBudgets[poolId]) {
        nextBudgets[poolId] = {
          ...nextBudgets[poolId],
          ...patch.poolBudgets[poolId],
        };
      }
    }
  }
  return {
    ...base,
    ...patch,
    plan: nextPlan,
    weights: patch.weights
      ? {
          ...base.weights,
          ...patch.weights,
          poolMultipliers: {
            ...base.weights.poolMultipliers,
            ...(patch.weights.poolMultipliers ?? {}),
          },
        }
      : {
          ...base.weights,
          poolMultipliers: { ...base.weights.poolMultipliers },
        },
    poolBudgets: nextBudgets,
    alerts: patch.alerts ? { ...base.alerts, ...patch.alerts } : { ...base.alerts },
    customBrainDirs: patch.customBrainDirs
      ? [...patch.customBrainDirs]
      : [...base.customBrainDirs],
  };
}

export function loadState(dataDir?: string): PersistentState {
  const filePath = getStateFilePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return createDefaultState();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistentState>;
    const defaults = createDefaultState();
    return {
      version: STATE_VERSION,
      config: parsed.config ? mergeConfig(defaults.config, parsed.config) : defaults.config,
      calibrations: parsed.calibrations ?? {},
      scanCache: parsed.scanCache ?? {},
      lastAlertAtMs: parsed.lastAlertAtMs ?? {},
    };
  } catch {
    return createDefaultState();
  }
}

export function saveState(state: PersistentState, dataDir?: string): void {
  const filePath = getStateFilePath(dataDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function calibrationKey(poolId: PoolId, windowKind: 'short' | 'weekly'): string {
  return `${poolId}:${windowKind}`;
}
