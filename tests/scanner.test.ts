import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultConfig, scanTranscripts } from '../src/core/index.js';

const tempDirs: string[] = [];

function makeTempBrain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-scan-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Incremental Transcript Scanner', () => {
  it('parses PLANNER_RESPONSE token metrics, tool calls, and USER_INPUT title', () => {
    const brainDir = makeTempBrain();
    const convId = 'conv-001';
    const logDir = path.join(brainDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'transcript.jsonl');

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-27T02:00:00Z',
        content: '<USER_REQUEST>\n实现额度监控与预测功能\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-27T02:00:10Z',
        model: 'gemini-4-neon-high',
        input_tokens: 12000,
        cache_read_tokens: 30000,
        output_tokens: 1500,
        tool_calls: [
          { name: 'read_file', args: { Path: '/workspace/sample-project/src/core/engine.ts' } },
          { name: 'write_file' },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-11-27T02:00:12Z',
        content: 'tool output',
      }),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const config = createDefaultConfig('ai-pro');
    const first = scanTranscripts(config, {}, [{ surface: 'antigravity', dirPath: brainDir }]);

    expect(first.scannedFilesCount).toBe(1);
    expect(first.updatedFilesCount).toBe(1);
    expect(first.events).toHaveLength(1);
    expect(first.events[0].inputTokens).toBe(12000);
    expect(first.events[0].cacheReadTokens).toBe(30000);
    expect(first.events[0].outputTokens).toBe(1500);
    expect(first.events[0].totalTokens).toBe(43500);
    expect(first.events[0].poolId).toBe('gemini-pro');
    expect(first.events[0].toolNames).toEqual(['read_file', 'write_file']);
    expect(first.conversations.get(convId)?.title).toBe('实现额度监控与预测功能');
    expect(first.conversations.get(convId)?.projectName).toBe('sample-project');

    // Second scan with no file changes should hit cache
    const second = scanTranscripts(config, first.cache, [
      { surface: 'antigravity', dirPath: brainDir },
    ]);
    expect(second.updatedFilesCount).toBe(0);
    expect(second.events).toHaveLength(1);

    // Append a new PLANNER_RESPONSE line and verify incremental byte-offset read
    const appended = JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T02:05:00Z',
      model: 'gemini-3-flash',
      input_tokens: 4000,
      cache_read_tokens: 8000,
      output_tokens: 500,
      tool_calls: [{ name: 'run_command' }],
    });
    fs.appendFileSync(file, `${appended}\n`, 'utf8');

    const third = scanTranscripts(config, second.cache, [
      { surface: 'antigravity', dirPath: brainDir },
    ]);
    expect(third.updatedFilesCount).toBe(1);
    expect(third.events).toHaveLength(2);
    expect(third.events[1].poolId).toBe('gemini-flash');
    expect(third.events[1].totalTokens).toBe(12500);
  });

  it('safely holds back incomplete trailing JSON line until completed', () => {
    const brainDir = makeTempBrain();
    const logDir = path.join(brainDir, 'conv-partial', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'transcript.jsonl');

    const line1 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T03:00:00Z',
      model: 'claude-3.7-sonnet',
      input_tokens: 5000,
      cache_read_tokens: 0,
      output_tokens: 1000,
    });
    const partialLine2 = '{"step_index":2,"type":"PLANNER_RESPONSE","created_at":"2026-11-27T03:01:00Z","model":"claude-3.7-sonnet","input_to';
    fs.writeFileSync(file, `${line1}\n${partialLine2}`, 'utf8');

    const config = createDefaultConfig('ai-pro');
    const res1 = scanTranscripts(config, {}, [{ surface: 'antigravity', dirPath: brainDir }]);
    expect(res1.events).toHaveLength(1);
    expect(res1.events[0].poolId).toBe('partner');

    // Complete the trailing line
    fs.appendFileSync(file, 'kens":6000,"cache_read_tokens":2000,"output_tokens":800}\n', 'utf8');
    const res2 = scanTranscripts(config, res1.cache, [
      { surface: 'antigravity', dirPath: brainDir },
    ]);
    expect(res2.events).toHaveLength(2);
    expect(res2.events[1].inputTokens).toBe(6000);
  });
});
