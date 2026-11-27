import {
  calibrationKey,
  loadState,
  mergeConfig,
  saveState,
} from './config.js';
import {
  applyCalibration,
  buildUsageSnapshot,
} from './engine.js';
import {
  fetchConversationMetadataFromService,
  scanTranscripts,
  type BrainRoot,
} from './scanner.js';
import type {
  CalibrationInput,
  MonitorConfig,
  PoolId,
  UsageSnapshot,
  WindowKind,
} from './types.js';

export * from './types.js';
export * from './config.js';
export * from './scanner.js';
export * from './engine.js';
export * from './report.js';
export * from './simulator.js';
export * from './notifier.js';

export interface CollectOptions {
  dataDir?: string;
  nowMs?: number;
  overrideRoots?: BrainRoot[];
  enrichTitles?: boolean;
  persistCache?: boolean;
}

export async function collectUsageSnapshot(options: CollectOptions = {}): Promise<UsageSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(options.dataDir);
  const scan = scanTranscripts(state.config, state.scanCache, options.overrideRoots);

  if (options.enrichTitles !== false) {
    const remoteMeta = await fetchConversationMetadataFromService();
    for (const [id, info] of remoteMeta.entries()) {
      const meta = scan.conversations.get(id);
      if (!meta) continue;
      if (info.title) meta.title = info.title;
      if (info.projectId && meta.projectName === 'Default Workspace') {
        meta.projectName = info.projectId;
      }
    }
  }

  state.scanCache = scan.cache;
  if (options.persistCache !== false) {
    try {
      saveState(state, options.dataDir);
    } catch {
      // Gracefully continue in read-only or sandboxed environments
    }
  }

  return buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );
}

export async function calibrateAndSnapshot(
  input: CalibrationInput,
  options: CollectOptions = {},
): Promise<{
  snapshot: UsageSnapshot;
  learnedUpdated: boolean;
  previousTokensPerPct: number;
  newTokensPerPct: number;
  predictedPctBefore: number;
  absoluteErrorPct: number;
}> {
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(options.dataDir);
  const scan = scanTranscripts(state.config, state.scanCache, options.overrideRoots);
  state.scanCache = scan.cache;

  const calResult = applyCalibration(state, scan.events, input, nowMs);
  saveState(state, options.dataDir);

  const snapshot = buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );

  return {
    snapshot,
    learnedUpdated: calResult.learnedUpdated,
    previousTokensPerPct: calResult.previousTokensPerPct,
    newTokensPerPct: calResult.newTokensPerPct,
    predictedPctBefore: calResult.predictedPctBefore,
    absoluteErrorPct: calResult.absoluteErrorPct,
  };
}

export async function updateConfigAndSnapshot(
  patch: Partial<MonitorConfig>,
  options: CollectOptions = {},
): Promise<UsageSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(options.dataDir);
  state.config = mergeConfig(state.config, patch);
  const scan = scanTranscripts(state.config, state.scanCache, options.overrideRoots);
  state.scanCache = scan.cache;
  saveState(state, options.dataDir);

  return buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );
}

export async function resetCalibrationAndSnapshot(
  poolId?: PoolId,
  windowKind?: WindowKind,
  options: CollectOptions = {},
): Promise<UsageSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(options.dataDir);
  if (!poolId) {
    state.calibrations = {};
  } else if (windowKind) {
    delete state.calibrations[calibrationKey(poolId, windowKind)];
  } else {
    delete state.calibrations[calibrationKey(poolId, 'short')];
    delete state.calibrations[calibrationKey(poolId, 'weekly')];
  }
  const scan = scanTranscripts(state.config, state.scanCache, options.overrideRoots);
  state.scanCache = scan.cache;
  saveState(state, options.dataDir);

  return buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );
}
