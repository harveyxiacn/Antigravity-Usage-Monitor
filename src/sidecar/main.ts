#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCalibration,
  buildUsageSnapshot,
  calibrationKey,
  fetchConversationMetadataFromService,
  loadState,
  mergeConfig,
  renderCsvReport,
  renderMarkdownReport,
  saveState,
  scanTranscripts,
  simulateWorkload,
  type PersistentState,
  type PlanId,
  type PoolId,
  type RemoteConversationInfo,
  type UsageSnapshot,
  type WindowKind,
} from '../core/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SNAPSHOT_TTL_MS = 2_000;
const DISK_FLUSH_INTERVAL_MS = 30_000;
const TITLE_REFRESH_INTERVAL_MS = 60_000;

let memState: PersistentState | null = null;
let cachedSnapshot: UsageSnapshot | null = null;
let cachedSnapshotAtMs = 0;
let cachedHtmlTemplate: string | null = null;
let remoteMetaCache = new Map<string, RemoteConversationInfo>();
let lastDiskFlushMs = 0;
let stateDirty = false;

function getDataDir(): string | undefined {
  return process.env.AGY_USAGE_DATA_DIR || process.env.PLUGIN_DATA || undefined;
}

function resolveHtmlPath(): string {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.resolve(__dirname, '..', 'ui', 'index.html'),
    path.resolve(__dirname, '..', '..', 'dist', 'ui', 'index.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function getHtmlTemplate(): string {
  if (cachedHtmlTemplate !== null) return cachedHtmlTemplate;
  const htmlPath = resolveHtmlPath();
  if (fs.existsSync(htmlPath)) {
    cachedHtmlTemplate = fs.readFileSync(htmlPath, 'utf8');
    return cachedHtmlTemplate;
  }
  return '<!doctype html><html><body><h3>Usage Monitor UI not built</h3></body></html>';
}

function getState(): PersistentState {
  if (!memState) {
    memState = loadState(getDataDir());
  }
  return memState;
}

function flushStateToDisk(force = false): void {
  if (!memState) return;
  const now = Date.now();
  if (!force && (!stateDirty || now - lastDiskFlushMs < DISK_FLUSH_INTERVAL_MS)) {
    return;
  }
  try {
    saveState(memState, getDataDir());
    lastDiskFlushMs = now;
    stateDirty = false;
  } catch {
    // non-fatal in read-only env
  }
}

function refreshRemoteTitlesInBackground(): void {
  void fetchConversationMetadataFromService()
    .then((meta) => {
      if (meta.size > 0) {
        remoteMetaCache = meta;
        cachedSnapshotAtMs = 0; // invalidate snapshot TTL on next poll
      }
    })
    .catch(() => {
      // silent fallback
    });
}

function computeSnapshotSync(forceRefresh = false): UsageSnapshot {
  const nowMs = Date.now();
  if (!forceRefresh && cachedSnapshot && nowMs - cachedSnapshotAtMs < SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }

  const state = getState();
  const scan = scanTranscripts(state.config, state.scanCache);

  for (const [id, info] of remoteMetaCache.entries()) {
    const meta = scan.conversations.get(id);
    if (!meta) continue;
    if (info.title) meta.title = info.title;
    if (info.projectId && meta.projectName === 'Default Workspace') {
      meta.projectName = info.projectId;
    }
  }

  if (scan.updatedFilesCount > 0) {
    state.scanCache = scan.cache;
    stateDirty = true;
    flushStateToDisk(false);
  }

  cachedSnapshot = buildUsageSnapshot(
    scan.events,
    scan.conversations,
    state,
    scan.scannedFilesCount,
    nowMs,
  );
  cachedSnapshotAtMs = nowMs;
  return cachedSnapshot;
}

function renderHtmlWithBootstrapSnapshot(): string {
  const tpl = getHtmlTemplate();
  try {
    const snap = computeSnapshotSync(false);
    const safeJson = JSON.stringify(snap).replace(/</g, '\\u003c');
    const inject = `<script>window.__INITIAL_SNAPSHOT__=${safeJson};</script>`;
    if (tpl.includes('</head>')) {
      return tpl.replace('</head>', `${inject}</head>`);
    }
    return `${inject}${tpl}`;
  } catch {
    return tpl;
  }
}

function handleApiSync(route: string, body: Record<string, unknown>): unknown {
  if (route === '/api/snapshot') {
    return computeSnapshotSync(false);
  }

  if (route === '/api/calibrate') {
    const nowMs = Date.now();
    const state = getState();
    const scan = scanTranscripts(state.config, state.scanCache);
    state.scanCache = scan.cache;

    const calResult = applyCalibration(
      state,
      scan.events,
      {
        poolId: (body.poolId as PoolId) ?? 'gemini-pro',
        windowKind: (body.windowKind as WindowKind) ?? 'short',
        remainingPct: Number(body.remainingPct ?? 100),
        resetInMinutes:
          body.resetInMinutes !== undefined ? Number(body.resetInMinutes) : undefined,
        nextResetAtIso:
          typeof body.nextResetAtIso === 'string' ? body.nextResetAtIso : undefined,
      },
      nowMs,
    );
    stateDirty = true;
    flushStateToDisk(true);

    const snapshot = computeSnapshotSync(true);
    return {
      snapshot,
      learnedUpdated: calResult.learnedUpdated,
      previousTokensPerPct: calResult.previousTokensPerPct,
      newTokensPerPct: calResult.newTokensPerPct,
      predictedPctBefore: calResult.predictedPctBefore,
      absoluteErrorPct: calResult.absoluteErrorPct,
    };
  }

  if (route === '/api/reset-calibration') {
    const state = getState();
    const poolId = body.poolId as PoolId | undefined;
    const windowKind = body.windowKind as WindowKind | undefined;
    if (!poolId) {
      state.calibrations = {};
    } else if (windowKind) {
      delete state.calibrations[calibrationKey(poolId, windowKind)];
    } else {
      delete state.calibrations[calibrationKey(poolId, 'short')];
      delete state.calibrations[calibrationKey(poolId, 'weekly')];
    }
    stateDirty = true;
    flushStateToDisk(true);
    return computeSnapshotSync(true);
  }

  if (route === '/api/simulate') {
    const snap = computeSnapshotSync(false);
    return simulateWorkload(snap, {
      poolId: body.poolId as PoolId | undefined,
      windowKind: (body.windowKind as WindowKind) ?? 'short',
      additionalTurns:
        body.additionalTurns !== undefined ? Number(body.additionalTurns) : undefined,
      additionalMinutes:
        body.additionalMinutes !== undefined ? Number(body.additionalMinutes) : undefined,
      offloadToFlashPct:
        body.offloadToFlashPct !== undefined ? Number(body.offloadToFlashPct) : 0,
    });
  }

  if (route === '/api/config') {
    const state = getState();
    const hasCustomBudget = Boolean(
      body.proShortBudget || body.flashShortBudget || body.partnerShortBudget,
    );
    state.config = mergeConfig(state.config, {
      ...(body.plan ? { plan: body.plan as PlanId } : {}),
      ...(body.shortWindowMinutes
        ? { shortWindowMinutes: Number(body.shortWindowMinutes) }
        : {}),
      ...(body.safetyBufferPct !== undefined
        ? { safetyBufferPct: Number(body.safetyBufferPct) }
        : {}),
      ...(body.dutyCyclePrior !== undefined
        ? { dutyCyclePrior: Number(body.dutyCyclePrior) }
        : {}),
      ...(hasCustomBudget
        ? {
            poolBudgets: {
              'gemini-pro': {
                ...state.config.poolBudgets['gemini-pro'],
                ...(body.proShortBudget
                  ? { shortWeightedTokens: Number(body.proShortBudget) }
                  : {}),
              },
              'gemini-flash': {
                ...state.config.poolBudgets['gemini-flash'],
                ...(body.flashShortBudget
                  ? { shortWeightedTokens: Number(body.flashShortBudget) }
                  : {}),
              },
              partner: {
                ...state.config.poolBudgets.partner,
                ...(body.partnerShortBudget
                  ? { shortWeightedTokens: Number(body.partnerShortBudget) }
                  : {}),
              },
            },
          }
        : {}),
      alerts: {
        ...state.config.alerts,
        ...(body.warningRemainingPct !== undefined
          ? { warningRemainingPct: Number(body.warningRemainingPct) }
          : {}),
        ...(body.criticalRemainingPct !== undefined
          ? { criticalRemainingPct: Number(body.criticalRemainingPct) }
          : {}),
        ...(body.alertsEnabled !== undefined
          ? { enabled: Boolean(body.alertsEnabled) }
          : {}),
        ...(body.desktopNotification !== undefined
          ? { desktopNotification: Boolean(body.desktopNotification) }
          : {}),
      },
    });
    stateDirty = true;
    flushStateToDisk(true);
    return computeSnapshotSync(true);
  }

  if (route === '/api/report') {
    const snap = computeSnapshotSync(false);
    const format = body.format === 'csv' ? 'csv' : 'markdown';
    const report = format === 'csv' ? renderCsvReport(snap) : renderMarkdownReport(snap);
    return { format, report };
  }

  return { error: `Unknown route: ${route}` };
}

interface SidecarSdkModule {
  SidecarApp: new () => {
    page(route: string, handler: () => string): void;
    api(
      route: string,
      handler: (data: Record<string, unknown>) => unknown,
      method?: string,
    ): void;
    run(): void;
  };
}

async function startWithSidecarSdk(): Promise<boolean> {
  try {
    const modName = 'sidecar_sdk';
    const sdk = (await import(modName)) as SidecarSdkModule;
    const app = new sdk.SidecarApp();

    // Pre-warm state & snapshot in RAM before first browser request
    computeSnapshotSync(true);
    refreshRemoteTitlesInBackground();
    setInterval(refreshRemoteTitlesInBackground, TITLE_REFRESH_INTERVAL_MS).unref();

    app.page('/', () => renderHtmlWithBootstrapSnapshot());
    app.api('/api/snapshot', () => handleApiSync('/api/snapshot', {}), 'GET');
    app.api('/api/calibrate', (data) => handleApiSync('/api/calibrate', data ?? {}), 'POST');
    app.api(
      '/api/reset-calibration',
      (data) => handleApiSync('/api/reset-calibration', data ?? {}),
      'POST',
    );
    app.api('/api/simulate', (data) => handleApiSync('/api/simulate', data ?? {}), 'POST');
    app.api('/api/config', (data) => handleApiSync('/api/config', data ?? {}), 'POST');
    app.api('/api/report', (data) => handleApiSync('/api/report', data ?? {}), 'POST');

    app.run();
    return true;
  } catch {
    return false;
  }
}

function startFallbackHttpServer(): void {
  const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 4387);
  computeSnapshotSync(true);
  refreshRemoteTitlesInBackground();
  setInterval(refreshRemoteTitlesInBackground, TITLE_REFRESH_INTERVAL_MS).unref();

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtmlWithBootstrapSnapshot());
      return;
    }

    if (urlPath.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      let body: Record<string, unknown> = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      try {
        const result = handleApiSync(urlPath, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        );
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[antigravity-usage-monitor] Sidecar fallback server on http://127.0.0.1:${port}`);
  });
}

async function main(): Promise<void> {
  const ok = await startWithSidecarSdk();
  if (!ok) {
    startFallbackHttpServer();
  }
}

void main();
