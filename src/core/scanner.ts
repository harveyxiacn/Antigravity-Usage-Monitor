import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeWeightedTokens, resolveModelPool } from './config.js';
import type {
  CachedTranscriptFile,
  ConversationMeta,
  MonitorConfig,
  SurfaceName,
  UsageEvent,
} from './types.js';

export interface BrainRoot {
  surface: SurfaceName;
  dirPath: string;
}

export interface ScanResult {
  events: UsageEvent[];
  conversations: Map<string, ConversationMeta>;
  scannedFilesCount: number;
  updatedFilesCount: number;
  cache: Record<string, CachedTranscriptFile>;
}

export function getDefaultBrainRoots(customBrainDirs: string[] = []): BrainRoot[] {
  const home = os.homedir();
  const geminiRoot = path.join(home, '.gemini');
  const roots: BrainRoot[] = [
    { surface: 'antigravity', dirPath: path.join(geminiRoot, 'antigravity', 'brain') },
    { surface: 'antigravity-cli', dirPath: path.join(geminiRoot, 'antigravity-cli', 'brain') },
    { surface: 'antigravity-ide', dirPath: path.join(geminiRoot, 'antigravity-ide', 'brain') },
  ];
  for (const dir of customBrainDirs) {
    if (dir && dir.trim()) {
      roots.push({ surface: 'custom', dirPath: path.resolve(dir.trim()) });
    }
  }
  return roots;
}

export function discoverTranscriptFiles(
  roots: BrainRoot[],
): Array<{ transcriptPath: string; conversationId: string; surface: SurfaceName }> {
  const results: Array<{ transcriptPath: string; conversationId: string; surface: SurfaceName }> =
    [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root.dirPath)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const conversationId = entry.name;
      const candidatePaths = [
        path.join(root.dirPath, conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(root.dirPath, conversationId, 'transcript.jsonl'),
      ];
      for (const candidate of candidatePaths) {
        const normalized = path.normalize(candidate);
        if (seen.has(normalized)) continue;
        if (fs.existsSync(normalized)) {
          seen.add(normalized);
          results.push({
            transcriptPath: normalized,
            conversationId,
            surface: root.surface,
          });
          break;
        }
      }
    }
  }
  return results;
}

export function extractUserTitle(rawContent: string): string {
  if (!rawContent) return '';
  let text = rawContent;
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch && reqMatch[1]) {
    text = reqMatch[1];
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function parseTimestamp(raw: unknown, fallbackMs: number): { ms: number; iso: string } {
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) {
      return { ms, iso: new Date(ms).toISOString() };
    }
  }
  return { ms: fallbackMs, iso: new Date(fallbackMs).toISOString() };
}

function parseTranscriptLine(
  line: string,
  conversationId: string,
  surface: SurfaceName,
  fallbackMs: number,
  config: MonitorConfig,
): { event?: UsageEvent; userTitle?: string; timestampMs?: number } {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }

  const ts = parseTimestamp(obj.created_at ?? obj.createdAt, fallbackMs);

  if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
    const title = extractUserTitle(obj.content);
    return { userTitle: title || undefined, timestampMs: ts.ms };
  }

  const hasTokens =
    obj.input_tokens !== undefined ||
    obj.cache_read_tokens !== undefined ||
    obj.output_tokens !== undefined ||
    obj.inputTokens !== undefined ||
    obj.cacheReadTokens !== undefined ||
    obj.outputTokens !== undefined;

  if (obj.type !== 'PLANNER_RESPONSE' && !hasTokens) {
    return { timestampMs: ts.ms };
  }

  const inputTokens = toNumber(obj.input_tokens ?? obj.inputTokens);
  const cacheReadTokens = toNumber(obj.cache_read_tokens ?? obj.cacheReadTokens);
  const outputTokens = toNumber(obj.output_tokens ?? obj.outputTokens);
  const totalTokens = inputTokens + cacheReadTokens + outputTokens;

  const model =
    typeof obj.model === 'string' && obj.model.trim()
      ? obj.model.trim()
      : typeof obj.model_name === 'string' && obj.model_name.trim()
        ? obj.model_name.trim()
        : 'unknown';

  const poolId = resolveModelPool(model);
  const weightedTokens = computeWeightedTokens(
    inputTokens,
    cacheReadTokens,
    outputTokens,
    poolId,
    config.weights,
  );

  const toolNames: string[] = [];
  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      if (tc && typeof tc === 'object' && typeof (tc as Record<string, unknown>).name === 'string') {
        toolNames.push((tc as Record<string, unknown>).name as string);
      }
    }
  }

  if (totalTokens === 0 && toolNames.length === 0) {
    return { timestampMs: ts.ms };
  }

  const stepIndex = toNumber(obj.step_index ?? obj.stepIndex);

  return {
    timestampMs: ts.ms,
    event: {
      conversationId,
      surface,
      stepIndex,
      timestampMs: ts.ms,
      createdAt: ts.iso,
      model,
      poolId,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      weightedTokens,
      toolNames,
    },
  };
}

function readNewLines(
  filePath: string,
  startOffset: number,
  fileSize: number,
): { lines: string[]; nextOffset: number } {
  const bytesToRead = fileSize - startOffset;
  if (bytesToRead <= 0) {
    return { lines: [], nextOffset: startOffset };
  }
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
    const slice = buffer.subarray(0, bytesRead);
    const lastNewlineIdx = slice.lastIndexOf(0x0a); // '\n'

    // If the file doesn't end with a newline, try parsing the tail only if valid JSON,
    // otherwise keep byteOffset at last newline so we don't split an in-progress write.
    let consumedBytes = bytesRead;
    let textToParse = slice.toString('utf8');

    if (lastNewlineIdx === -1) {
      const trimmed = textToParse.trim();
      if (!trimmed) {
        return { lines: [], nextOffset: startOffset + bytesRead };
      }
      try {
        JSON.parse(trimmed);
        return { lines: [trimmed], nextOffset: startOffset + bytesRead };
      } catch {
        return { lines: [], nextOffset: startOffset };
      }
    }

    const tail = slice.subarray(lastNewlineIdx + 1).toString('utf8').trim();
    if (tail.length > 0) {
      try {
        JSON.parse(tail);
        // tail is complete valid JSON
      } catch {
        // incomplete trailing write — stop at last newline
        consumedBytes = lastNewlineIdx + 1;
        textToParse = slice.subarray(0, consumedBytes).toString('utf8');
      }
    }

    const lines = textToParse
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    return {
      lines,
      nextOffset: startOffset + consumedBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function scanTranscripts(
  config: MonitorConfig,
  existingCache: Record<string, CachedTranscriptFile> = {},
  overrideRoots?: BrainRoot[],
): ScanResult {
  const roots = overrideRoots ?? getDefaultBrainRoots(config.customBrainDirs);
  const discovered = discoverTranscriptFiles(roots);
  const nextCache: Record<string, CachedTranscriptFile> = {};
  const allEvents: UsageEvent[] = [];
  const conversations = new Map<string, ConversationMeta>();
  let updatedFilesCount = 0;

  for (const item of discovered) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(item.transcriptPath);
    } catch {
      continue;
    }

    const cached = existingCache[item.transcriptPath];
    let entry: CachedTranscriptFile;

    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.byteOffset <= stat.size
    ) {
      // Recompute weightedTokens in case config weights changed
      entry = {
        ...cached,
        events: cached.events.map((ev) => ({
          ...ev,
          poolId: resolveModelPool(ev.model),
          weightedTokens: computeWeightedTokens(
            ev.inputTokens,
            ev.cacheReadTokens,
            ev.outputTokens,
            resolveModelPool(ev.model),
            config.weights,
          ),
        })),
      };
    } else {
      updatedFilesCount += 1;
      const canAppend = cached && stat.size >= cached.byteOffset && cached.byteOffset > 0;
      const startOffset = canAppend ? cached.byteOffset : 0;
      const baseEvents = canAppend
        ? cached.events.map((ev) => ({
            ...ev,
            poolId: resolveModelPool(ev.model),
            weightedTokens: computeWeightedTokens(
              ev.inputTokens,
              ev.cacheReadTokens,
              ev.outputTokens,
              resolveModelPool(ev.model),
              config.weights,
            ),
          }))
        : [];
      let title = canAppend ? cached.title : '';
      let firstTimestampMs = canAppend ? cached.firstTimestampMs : Number.POSITIVE_INFINITY;
      let lastTimestampMs = canAppend ? cached.lastTimestampMs : 0;

      const { lines, nextOffset } = readNewLines(item.transcriptPath, startOffset, stat.size);
      for (const line of lines) {
        const parsed = parseTranscriptLine(
          line,
          item.conversationId,
          item.surface,
          stat.mtimeMs,
          config,
        );
        if (parsed.timestampMs) {
          if (parsed.timestampMs < firstTimestampMs) firstTimestampMs = parsed.timestampMs;
          if (parsed.timestampMs > lastTimestampMs) lastTimestampMs = parsed.timestampMs;
        }
        if (!title && parsed.userTitle) {
          title = parsed.userTitle;
        }
        if (parsed.event) {
          baseEvents.push(parsed.event);
        }
      }

      if (!Number.isFinite(firstTimestampMs)) firstTimestampMs = stat.mtimeMs;
      if (lastTimestampMs === 0) lastTimestampMs = stat.mtimeMs;

      entry = {
        transcriptPath: item.transcriptPath,
        conversationId: item.conversationId,
        surface: item.surface,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        byteOffset: nextOffset,
        title: title || `Session ${item.conversationId.slice(0, 8)}`,
        firstTimestampMs,
        lastTimestampMs,
        events: baseEvents,
      };
    }

    nextCache[item.transcriptPath] = entry;
    for (const ev of entry.events) {
      allEvents.push(ev);
    }
    conversations.set(entry.conversationId, {
      conversationId: entry.conversationId,
      surface: entry.surface,
      title: entry.title,
      firstTimestampMs: entry.firstTimestampMs,
      lastTimestampMs: entry.lastTimestampMs,
      transcriptPath: entry.transcriptPath,
    });
  }

  allEvents.sort((a, b) => a.timestampMs - b.timestampMs || a.stepIndex - b.stepIndex);

  return {
    events: allEvents,
    conversations,
    scannedFilesCount: discovered.length,
    updatedFilesCount,
    cache: nextCache,
  };
}

/**
 * Optionally enriches conversation titles using the documented Antigravity ConversationService API.
 * Never throws; returns empty map if env vars are absent or service is unreachable.
 */
export async function fetchConversationTitlesFromService(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddress || !csrfToken) {
    return titles;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const res = await fetch(
      `http://${lsAddress}/product.v1.ConversationService/ListConversations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-antigravity-csrf-token': csrfToken,
        },
        body: JSON.stringify({ pageSize: 100, includeArchived: true }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return titles;
    const data = (await res.json()) as {
      conversations?: Array<{
        id?: string;
        annotations?: { title?: string };
        state?: { summary?: string };
      }>;
    };
    for (const conv of data.conversations ?? []) {
      if (!conv.id) continue;
      const title = conv.annotations?.title?.trim() || conv.state?.summary?.trim();
      if (title) {
        titles.set(conv.id, title);
      }
    }
  } catch {
    // Silent fallback to transcript titles
  } finally {
    clearTimeout(timeout);
  }
  return titles;
}
