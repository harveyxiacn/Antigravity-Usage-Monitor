import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  APP_MIME_TYPE,
  APP_RESOURCE_URI,
  createUsageMonitorServer,
} from '../src/mcp/server.js';
import type { UsageSnapshot } from '../src/core/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('MCP Server & MCP App Protocol', () => {
  it('exposes ui:// resource, entrypoints, calibration, and app-only tools over MCP', async () => {
    const dataDir = makeTempDir('agy-mcp-data-');
    const brainDir = makeTempDir('agy-mcp-brain-');
    const nowMs = Date.parse('2026-11-27T11:30:00Z');

    const logDir = path.join(brainDir, 'conv-mcp', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-27T11:00:00Z',
          content: '<USER_REQUEST>测试 MCP 额度面板</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-27T11:10:00Z',
          model: 'gemini-4-neon-high',
          input_tokens: 25_000,
          cache_read_tokens: 50_000,
          output_tokens: 4_000,
          tool_calls: [{ name: 'read_file' }],
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const server = createUsageMonitorServer({
      dataDir,
      overrideRoots: [{ surface: 'antigravity', dirPath: brainDir }],
      nowProvider: () => nowMs,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // 1. Verify resources include ui:// with text/html;profile=mcp-app
      const resources = await client.listResources();
      const uiRes = resources.resources.find((r) => r.uri === APP_RESOURCE_URI);
      expect(uiRes).toBeDefined();
      expect(uiRes?.mimeType).toBe(APP_MIME_TYPE);

      const readRes = await client.readResource({ uri: APP_RESOURCE_URI });
      expect(readRes.contents[0].mimeType).toBe(APP_MIME_TYPE);
      expect('text' in readRes.contents[0] && readRes.contents[0].text.length).toBeGreaterThan(50);

      // 2. Verify tools metadata includes Antigravity aux_pane + global entrypoints and app-only visibility
      const toolsRes = await client.listTools();
      const openTool = toolsRes.tools.find((t) => t.name === 'open_usage_monitor');
      expect(openTool).toBeDefined();
      const meta = openTool?._meta as Record<string, unknown> | undefined;
      expect((meta?.ui as { resourceUri?: string })?.resourceUri).toBe(APP_RESOURCE_URI);
      const agyUi = meta?.['com.google.antigravity/ui'] as {
        entrypoints?: Array<{ type: string; title: string }>;
      };
      expect(agyUi?.entrypoints?.map((e) => e.type)).toEqual(['aux_pane', 'global']);

      const appOnlyTool = toolsRes.tools.find((t) => t.name === 'app_get_snapshot');
      expect(
        ((appOnlyTool?._meta as Record<string, unknown>)?.ui as { visibility?: string[] })
          ?.visibility,
      ).toEqual(['app']);

      // 3. Call open_usage_monitor with empty args {} (entrypoint requirement!)
      const openResult = await client.callTool({ name: 'open_usage_monitor', arguments: {} });
      const snap = openResult.structuredContent as unknown as UsageSnapshot;
      expect(snap.totals.allTime.totalTokens).toBe(79_000);
      expect(snap.conversations[0].title).toBe('测试 MCP 额度面板');

      // 4. Calibrate via calibrate_quota tool
      const calResult = await client.callTool({
        name: 'calibrate_quota',
        arguments: {
          poolId: 'gemini-pro',
          windowKind: 'short',
          remainingPct: 64,
          resetInMinutes: 120,
        },
      });
      const calStructured = calResult.structuredContent as unknown as {
        snapshot: UsageSnapshot;
      };
      const pro = calStructured.snapshot.pools.find((p) => p.poolId === 'gemini-pro')!;
      expect(pro.shortWindow.calibrated).toBe(true);
      expect(pro.shortWindow.currentRemainingPct).toBeCloseTo(64, 1);
      expect(pro.shortWindow.timeToResetMs).toBe(120 * 60_000);

      // 5. Export Markdown report via export_usage_report tool
      const reportRes = await client.callTool({
        name: 'export_usage_report',
        arguments: { format: 'markdown' },
      });
      const reportData = reportRes.structuredContent as { format: string; report: string };
      expect(reportData.format).toBe('markdown');
      expect(reportData.report).toContain('Antigravity Usage & Quota Forecast Report');

      // 6. Run What-If workload simulation via simulate_quota_scenario tool
      const simRes = await client.callTool({
        name: 'simulate_quota_scenario',
        arguments: {
          poolId: 'gemini-pro',
          additionalTurns: 10,
          offloadToFlashPct: 50,
        },
      });
      const simData = simRes.structuredContent as {
        savedPrimaryPct: number;
        withOffloadRemainingPct: number;
      };
      expect(simData.withOffloadRemainingPct).toBeGreaterThan(0);
      expect(simData.savedPrimaryPct).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
