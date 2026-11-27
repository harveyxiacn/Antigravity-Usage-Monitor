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

export interface RemoteConversationInfo {
  title?: string;
  projectId?: string;
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

/**
 * Heuristically infers a workspace/project folder name from file paths referenced by tool calls.
 * Ignores ~/.gemini internal paths and temporary directories.
 */
export function inferProjectNameFromPath(rawPath: string): string | undefined {
  if (!rawPath) return undefined;
  const cleaned = rawPath.replace(/^"+|"+$/g, '').replace(/\\/g, '/').trim();
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  if (lower.includes('/.gemini/') || lower.includes('/appdata/') || lower.includes('/temp/') || lower.startsWith('/tmp/')) {
    return undefined;
  }

  // Common project parent directory names (Projects, Project, workspace, workspaces, repos, src, code, dev, git)
  const parts = cleaned.split('/').filter(Boolean);
  const parentMarkers = new Set([
    'project',
    'projects',
    'workspace',
    'workspaces',
    'repo',
    'repos',
    'code',
    'dev',
    'work',
    'github',
    'git',
  ]);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parentMarkers.has(parts[i].toLowerCase())) {
      const candidate = parts[i + 1];
      if (candidate && !candidate.includes('.')) {
        return candidate;
      }
    }
  }

  // Fallback for Unix /Users/<user>/<repo>/... or Windows <drive>:/<repo>/...
  if (parts.length >= 2 && /^[a-z]:$/i.test(parts[0])) {
    const candidate = parts[1];
    if (candidate && !['users', 'windows', 'program files', 'program files (x86)'].includes(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
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
): { event?: UsageEvent; userTitle?: string; inferredProject?: string; timestampMs?: number } {
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
  let inferredProject: string | undefined;

  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const tcRec = tc as Record<string, unknown>;
      if (typeof tcRec.name === 'string') {
        toolNames.push(tcRec.name);
      }
      if (!inferredProject && tcRec.args && typeof tcRec.args === 'object') {
        const argsRec = tcRec.args as Record<string, unknown>;
        for (const key of ['Path', 'path', 'Cwd', 'cwd', 'Directory', 'TargetFile']) {
          if (typeof argsRec[key] === 'string') {
            const p = inferProjectNameFromPath(argsRec[key] as string);
            if (p) {
              inferredProject = p;
              break;
            }
          }
        }
      }
    }
  }

  if (totalTokens === 0 && toolNames.length === 0) {
    return { timestampMs: ts.ms, inferredProject };
  }

  const stepIndex = toNumber(obj.step_index ?? obj.stepIndex);

  return {
    timestampMs: ts.ms,
    inferredProject,
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
    const lastNewlineIdx = slice.lastIndexOf(0x0a);

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
      } catch {
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
      cached.byteOffset <= stat.size &&
      typeof cached.projectName === 'string'
    ) {
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
      const canAppend =
        cached &&
        stat.size >= cached.byteOffset &&
        cached.byteOffset > 0 &&
        typeof cached.projectName === 'string';
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
      let projectName = canAppend ? cached.projectName : '';
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
        if ((!projectName || projectName === 'Default Workspace') && parsed.inferredProject) {
          projectName = parsed.inferredProject;
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
        projectName: projectName || 'Default Workspace',
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
      projectName: entry.projectName,
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
 * Optionally enriches conversation titles and projectIds via the official ConversationService API.
 */
export async function fetchConversationMetadataFromService(): Promise<
  Map<string, RemoteConversationInfo>
> {
  const infoMap = new Map<string, RemoteConversationInfo>();
  const lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddress || !csrfToken) {
    return infoMap;
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
    if (!res.ok) return infoMap;
    const data = (await res.json()) as {
      conversations?: Array<{
        id?: string;
        metadata?: { projectId?: string };
        annotations?: { title?: string };
        state?: { summary?: string };
      }>;
    };
    for (const conv of data.conversations ?? []) {
      if (!conv.id) continue;
      const title = conv.annotations?.title?.trim() || conv.state?.summary?.trim();
      const projectId = conv.metadata?.projectId?.trim();
      if (title || projectId) {
        infoMap.set(conv.id, { title, projectId });
      }
    }
  } catch {
    // Silent fallback
  } finally {
    clearTimeout(timeout);
  }
  return infoMap;
}
