export type PlanId = 'free' | 'ai-pro' | 'ai-ultra' | 'custom';

export type PoolId = 'gemini-pro' | 'gemini-flash' | 'partner';

export type SurfaceName = 'antigravity' | 'antigravity-cli' | 'antigravity-ide' | 'custom';

export type WindowKind = 'short' | 'weekly';

export type HealthStatus = 'healthy' | 'caution' | 'warning' | 'critical' | 'exhausted';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type RecommendationSeverity = 'info' | 'warning' | 'critical';

export interface TokenWeights {
  inputWeight: number;
  cacheReadWeight: number;
  outputWeight: number;
  poolMultipliers: Record<PoolId, number>;
}

export interface PoolBudgets {
  shortWeightedTokens: number;
  weeklyWeightedTokens: number;
}

export interface PoolPricingUsdPer1M {
  inputPer1M: number;
  cacheReadPer1M: number;
  outputPer1M: number;
}

export interface AlertConfig {
  enabled: boolean;
  warningRemainingPct: number;
  criticalRemainingPct: number;
  cooldownMinutes: number;
  desktopNotification: boolean;
}

export interface MonitorConfig {
  plan: PlanId;
  shortWindowMinutes: number;
  weeklyWindowHours: number;
  safetyBufferPct: number;
  ewmaAlpha: number;
  bucketMinutes: number;
  recentMinutes: number;
  idleDecayHalfLifeMinutes: number;
  /** Prior active duty cycle (0.15 - 1.0) used to regularize cold-start bursts. */
  dutyCyclePrior: number;
  weights: TokenWeights;
  poolBudgets: Record<PoolId, PoolBudgets>;
  pricing: Record<PoolId, PoolPricingUsdPer1M>;
  alerts: AlertConfig;
  customBrainDirs: string[];
}

export interface UsageEvent {
  conversationId: string;
  surface: SurfaceName;
  stepIndex: number;
  timestampMs: number;
  createdAt: string;
  model: string;
  poolId: PoolId;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  weightedTokens: number;
  toolNames: string[];
}

export interface ConversationMeta {
  conversationId: string;
  surface: SurfaceName;
  title: string;
  projectName: string;
  firstTimestampMs: number;
  lastTimestampMs: number;
  transcriptPath: string;
}

export interface CostBreakdown {
  estimatedApiCostUsd: number;
  withoutCacheCostUsd: number;
  cacheSavingsUsd: number;
}

export interface TokenTotals {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  weightedTokens: number;
  cacheHitRate: number;
  savedByCacheTokens: number;
  turns: number;
  toolCalls: number;
  cost: CostBreakdown;
}

export interface CalibrationAnchor {
  poolId: PoolId;
  windowKind: WindowKind;
  remainingPct: number;
  nextResetAtMs: number;
  calibratedAtMs: number;
  cumulativeWeightedAtCalibration: number;
  learnedTokensPerPct?: number;
  sampleCount: number;
}

export interface CalibrationHistoryEntry {
  timestampMs: number;
  timestampIso: string;
  poolId: PoolId;
  windowKind: WindowKind;
  predictedPctBefore: number;
  actualPct: number;
  absoluteErrorPct: number;
  tokensPerPctAfter: number;
  learnedUpdated: boolean;
}

export interface CalibrationAccuracySummary {
  totalCalibrations: number;
  meanAbsoluteErrorPct: number | null;
  recentRecords: CalibrationHistoryEntry[];
}

export interface CalibrationInput {
  poolId: PoolId;
  windowKind?: WindowKind;
  remainingPct: number;
  resetInMinutes?: number;
  nextResetAtIso?: string;
}

export interface BurnRateEstimate {
  recentPctPerHour: number;
  ewmaPctPerHour: number;
  windowAvgPctPerHour: number;
  /** Regularized expected rate accounting for observed duty cycle + idle decay. */
  blendedPctPerHour: number;
  /** Unregularized continuous full-throttle coding rate. */
  rawActivePctPerHour: number;
  decayFactor: number;
  effectiveDutyCycle: number;
  observedDutyCycle: number;
  stdDevPctPerHour: number;
  activeMinutesInWindow: number;
  elapsedMinutesInWindow: number;
  idleMinutesSinceLastEvent: number;
  tokensPerMinute: number;
  weightedTokensPerMinute: number;
}

export interface PredictedRange {
  optimistic: number;
  expected: number;
  conservative: number;
}

export interface ForecastResult {
  windowKind: WindowKind;
  windowStartMs: number;
  windowDurationMs: number;
  currentRemainingPct: number;
  currentUsedPct: number;
  predictedRemainingPctAtReset: number;
  predictedRange: PredictedRange;
  activePacePredictedRemainingPct: number;
  nextResetAtMs: number;
  nextResetAtIso: string;
  timeToResetMs: number;
  estimatedExhaustionAtMs: number | null;
  runwayMinutes: number | null;
  projectedLockoutMinutes: number | null;
  safeBurnRatePctPerHour: number;
  safeTokensPerMinute: number;
  status: HealthStatus;
  confidence: ConfidenceLevel;
  calibrated: boolean;
  tokensPerPct: number;
}

export interface TimelinePoint {
  timestampMs: number;
  label: string;
  remainingPct: number;
  weightedTokens: number;
  projected: boolean;
  optimisticPct?: number;
  conservativePct?: number;
}

export interface HourlyBucket {
  hourStartMs: number;
  label: string;
  totalTokens: number;
  weightedTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
}

export interface DailyBucket {
  dateKey: string;
  totalTokens: number;
  weightedTokens: number;
  cacheHitRate: number;
  turns: number;
  toolCalls: number;
  estimatedApiCostUsd: number;
}

export interface SmartRecommendation {
  id: string;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
}

export interface PoolSnapshot {
  poolId: PoolId;
  displayName: string;
  models: string[];
  shortWindow: ForecastResult;
  weeklyWindow: ForecastResult;
  shortTokens: TokenTotals;
  weeklyTokens: TokenTotals;
  allTimeTokens: TokenTotals;
  burnRate: BurnRateEstimate;
  calibration?: CalibrationAnchor;
  weeklyCalibration?: CalibrationAnchor;
  timeline: TimelinePoint[];
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  projectName: string;
  surface: SurfaceName;
  models: string[];
  lastActiveAt: string;
  lastActiveMs: number;
  tokens: TokenTotals;
  peakContextTokens: number;
  avgTokensPerTurn: number;
  contextBloatRisk: boolean;
  shareOfAllTimePct: number;
}

export interface ProjectUsageSummary {
  projectName: string;
  conversationCount: number;
  topModel: string;
  tokens: TokenTotals;
  shareOfAllTimePct: number;
}

export interface ToolUsageSummary {
  name: string;
  calls: number;
  sharePct: number;
}

export interface ModelBreakdownSummary {
  model: string;
  poolId: PoolId;
  tokens: TokenTotals;
  shareOfAllTimePct: number;
}

export interface SimulationInput {
  poolId?: PoolId;
  windowKind?: WindowKind;
  additionalTurns?: number;
  additionalMinutes?: number;
  avgWeightedTokensPerTurn?: number;
  /** Fraction (0 - 100) of planned workload offloaded to gemini-flash. */
  offloadToFlashPct?: number;
}

export interface SimulationResult {
  poolId: PoolId;
  windowKind: WindowKind;
  baselineRemainingPct: number;
  simulatedAddedWeightedTokens: number;
  simulatedAddedPct: number;
  remainingAfterWorkloadPct: number;
  survivesUntilReset: boolean;
  offloadToFlashPct: number;
  withOffloadRemainingPct: number;
  flashImpactPct: number;
  savedPrimaryPct: number;
  recommendation: string;
}

export interface UsageSnapshot {
  generatedAtMs: number;
  generatedAtIso: string;
  plan: PlanId;
  primaryPoolId: PoolId;
  overallShort: ForecastResult;
  overallWeekly: ForecastResult;
  totals: {
    allTime: TokenTotals;
    today: TokenTotals;
    shortWindow: TokenTotals;
    weeklyWindow: TokenTotals;
  };
  pools: PoolSnapshot[];
  models: ModelBreakdownSummary[];
  projects: ProjectUsageSummary[];
  conversations: ConversationSummary[];
  topTools: ToolUsageSummary[];
  hourlyTrend24h: HourlyBucket[];
  dailyTrend7d: DailyBucket[];
  calibrationAccuracy: CalibrationAccuracySummary;
  recommendations: SmartRecommendation[];
  scannedFilesCount: number;
  totalEventsCount: number;
  config: MonitorConfig;
}

export interface CachedTranscriptFile {
  transcriptPath: string;
  conversationId: string;
  surface: SurfaceName;
  mtimeMs: number;
  size: number;
  byteOffset: number;
  title: string;
  projectName: string;
  firstTimestampMs: number;
  lastTimestampMs: number;
  events: UsageEvent[];
}

export interface PersistentState {
  version: number;
  config: MonitorConfig;
  calibrations: Record<string, CalibrationAnchor>;
  calibrationHistory: CalibrationHistoryEntry[];
  scanCache: Record<string, CachedTranscriptFile>;
  lastAlertAtMs: Record<string, number>;
}
