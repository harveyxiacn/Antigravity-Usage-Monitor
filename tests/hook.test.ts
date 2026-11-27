import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultState, saveState } from '../src/core/index.js';
import { evaluatePostInvocationHook } from '../src/hooks/post-invocation.js';

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

describe('PostInvocation Quota Alert Hook', () => {
  it('injects user_markdown warning on critical forecast and respects cooldown', () => {
    const dataDir = makeTempDir('agy-hook-data-');
    const brainDir = makeTempDir('agy-hook-brain-');

    const state = createDefaultState();
    state.config.poolBudgets['gemini-pro'].shortWeightedTokens = 100_000;
    state.config.alerts.cooldownMinutes = 15;
    saveState(state, dataDir);

    const nowMs = Date.parse('2026-11-27T10:00:00Z');
    const logDir = path.join(brainDir, 'conv-alert', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'transcript.jsonl');

    // Heavy usage pushing remaining well below critical threshold
    const lines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(nowMs - 10 * 60_000).toISOString(),
        model: 'gemini-4-neon-high',
        input_tokens: 45_000,
        cache_read_tokens: 0,
        output_tokens: 12_000,
      }),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const first = evaluatePostInvocationHook(
      { conversationId: 'conv-alert', hookEventName: 'PostInvocation' },
      {
        dataDir,
        nowMs,
        overrideRoots: [{ surface: 'antigravity', dirPath: brainDir }],
        enableDesktopNotify: false,
      },
    );

    expect(first.injectSteps).toHaveLength(1);
    expect(first.injectSteps![0].systemMessage.systemMessage).toBe('');
    expect(first.injectSteps![0].systemMessage.metadata?.user_markdown).toContain('Antigravity 额度预警');

    // 5 minutes later (within 15-min cooldown) -> suppressed
    const second = evaluatePostInvocationHook(
      { conversationId: 'conv-alert', hookEventName: 'PostInvocation' },
      {
        dataDir,
        nowMs: nowMs + 5 * 60_000,
        overrideRoots: [{ surface: 'antigravity', dirPath: brainDir }],
      },
    );
    expect(second.injectSteps).toBeUndefined();

    // 20 minutes later (past cooldown) -> alerts again
    const third = evaluatePostInvocationHook(
      { conversationId: 'conv-alert', hookEventName: 'PostInvocation' },
      {
        dataDir,
        nowMs: nowMs + 20 * 60_000,
        overrideRoots: [{ surface: 'antigravity', dirPath: brainDir }],
        enableDesktopNotify: false,
      },
    );
    expect(third.injectSteps).toHaveLength(1);
  });
});
