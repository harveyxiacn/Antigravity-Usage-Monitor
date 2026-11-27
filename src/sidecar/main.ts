#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calibrateAndSnapshot,
  collectUsageSnapshot,
  renderCsvReport,
  renderMarkdownReport,
  resetCalibrationAndSnapshot,
  simulateWorkload,
  updateConfigAndSnapshot,
  type PlanId,
  type PoolId,
  type WindowKind,
} from '../core/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function readDashboardHtml(): string {
  const htmlPath = resolveHtmlPath();
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, 'utf8');
  }
  return '<!doctype html><html><body><h3>Usage Monitor UI not built</h3></body></html>';
}

function getDataDir(): string | undefined {
  return process.env.AGY_USAGE_DATA_DIR || process.env.PLUGIN_DATA || undefined;
}

async function handleApi(
  route: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const opts = { dataDir: getDataDir() };

  if (route === '/api/snapshot') {
    return collectUsageSnapshot(opts);
  }

  if (route === '/api/calibrate') {
    return calibrateAndSnapshot(
      {
        poolId: (body.poolId as PoolId) ?? 'gemini-pro',
        windowKind: (body.windowKind as WindowKind) ?? 'short',
        remainingPct: Number(body.remainingPct ?? 100),
        resetInMinutes:
          body.resetInMinutes !== undefined ? Number(body.resetInMinutes) : undefined,
        nextResetAtIso:
          typeof body.nextResetAtIso === 'string' ? body.nextResetAtIso : undefined,
      },
      opts,
    );
  }

  if (route === '/api/reset-calibration') {
    return resetCalibrationAndSnapshot(
      body.poolId as PoolId | undefined,
      body.windowKind as WindowKind | undefined,
      opts,
    );
  }

  if (route === '/api/simulate') {
    const snap = await collectUsageSnapshot(opts);
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
    const current = await collectUsageSnapshot(opts);
    const hasCustomBudget = Boolean(
      body.proShortBudget || body.flashShortBudget || body.partnerShortBudget,
    );
    return updateConfigAndSnapshot(
      {
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
                  ...current.config.poolBudgets['gemini-pro'],
                  ...(body.proShortBudget
                    ? { shortWeightedTokens: Number(body.proShortBudget) }
                    : {}),
                },
                'gemini-flash': {
                  ...current.config.poolBudgets['gemini-flash'],
                  ...(body.flashShortBudget
                    ? { shortWeightedTokens: Number(body.flashShortBudget) }
                    : {}),
                },
                partner: {
                  ...current.config.poolBudgets.partner,
                  ...(body.partnerShortBudget
                    ? { shortWeightedTokens: Number(body.partnerShortBudget) }
                    : {}),
                },
              },
            }
          : {}),
        alerts: {
          ...current.config.alerts,
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
      },
      opts,
    );
  }

  if (route === '/api/report') {
    const snap = await collectUsageSnapshot(opts);
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
      handler: (data: Record<string, unknown>) => Promise<unknown> | unknown,
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

    app.page('/', () => readDashboardHtml());

    app.api('/api/snapshot', async () => handleApi('/api/snapshot', {}), 'GET');
    app.api('/api/calibrate', async (data) => handleApi('/api/calibrate', data ?? {}), 'POST');
    app.api(
      '/api/reset-calibration',
      async (data) => handleApi('/api/reset-calibration', data ?? {}),
      'POST',
    );
    app.api('/api/simulate', async (data) => handleApi('/api/simulate', data ?? {}), 'POST');
    app.api('/api/config', async (data) => handleApi('/api/config', data ?? {}), 'POST');
    app.api('/api/report', async (data) => handleApi('/api/report', data ?? {}), 'POST');

    app.run();
    return true;
  } catch {
    return false;
  }
}

function startFallbackHttpServer(): void {
  const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 4387);
  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readDashboardHtml());
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
        const result = await handleApi(urlPath, body);
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
