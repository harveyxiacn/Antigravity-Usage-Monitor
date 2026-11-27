import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import type {
  ForecastResult,
  HourlyBucket,
  PlanId,
  PoolId,
  PoolSnapshot,
  SimulationResult,
  UsageSnapshot,
  WindowKind,
} from '../core/types.js';

type ActiveTab = 'overview' | 'simulate' | 'trends' | 'conversations' | 'models' | 'settings';

const app = new App({ name: 'Antigravity Usage Monitor', version: '1.4.0' }, {});

let snapshot: UsageSnapshot | null = null;
let selectedPoolId: PoolId = 'gemini-pro';
let selectedWindow: WindowKind = 'short';
let activeTab: ActiveTab = 'overview';
let autoRefresh = true;
let isBusy = false;
let statusNotice = '';
let exportedReportText = '';
let simulationResult: SimulationResult | null = null;
let simTurns = 20;
let simMinutes = 0;
let simOffloadPct = 50;
let transportMode: 'none' | 'mcp' | 'sidecar' = 'none';
let canSendMessage = false;

function isBackendReady(): boolean {
  return transportMode !== 'none';
}

const TOOL_TO_SIDECAR_ROUTE: Record<string, { path: string; method: 'GET' | 'POST' }> = {
  app_get_snapshot: { path: '/api/snapshot', method: 'GET' },
  app_calibrate: { path: '/api/calibrate', method: 'POST' },
  app_reset_calibration: { path: '/api/reset-calibration', method: 'POST' },
  app_simulate: { path: '/api/simulate', method: 'POST' },
  app_save_config: { path: '/api/config', method: 'POST' },
  app_export_report: { path: '/api/report', method: 'POST' },
};

async function callBackend<T>(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<T | undefined> {
  if (transportMode === 'mcp') {
    const res = await app.callServerTool({
      name: toolName,
      arguments: args,
    });
    return (res as { structuredContent?: T }).structuredContent;
  }
  if (transportMode === 'sidecar') {
    const spec = TOOL_TO_SIDECAR_ROUTE[toolName];
    if (!spec) throw new Error(`Unsupported sidecar route: ${toolName}`);
    const res = await fetch(spec.path, {
      method: spec.method,
      headers: spec.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: spec.method === 'POST' ? JSON.stringify(args) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  return undefined;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(clamped / 86400);
  const hours = Math.floor((clamped % 86400) / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
  }
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${hh}:${mm}`;
  }
  return `${month}-${day} ${hh}:${mm}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status: ForecastResult['status']): string {
  switch (status) {
    case 'healthy':
      return '充裕健康';
    case 'caution':
      return '需留意节奏';
    case 'warning':
      return '预警 · 偏紧';
    case 'critical':
      return '高危 · 即将见底';
    case 'exhausted':
      return '已耗尽';
  }
}

function statusColor(status: ForecastResult['status']): string {
  switch (status) {
    case 'healthy':
      return 'var(--accent-success)';
    case 'caution':
    case 'warning':
      return 'var(--accent-warning)';
    case 'critical':
    case 'exhausted':
      return 'var(--accent-danger)';
  }
}

function getSelectedPool(): PoolSnapshot | null {
  if (!snapshot) return null;
  return snapshot.pools.find((p) => p.poolId === selectedPoolId) ?? snapshot.pools[0] ?? null;
}

function renderGaugeSvg(forecast: ForecastResult): string {
  const size = 168;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 68;
  const rInner = 54;
  const cOuter = 2 * Math.PI * rOuter;
  const cInner = 2 * Math.PI * rInner;

  const currentDash = (forecast.currentRemainingPct / 100) * cOuter;
  const predDash = (forecast.predictedRemainingPctAtReset / 100) * cInner;
  const color = statusColor(forecast.status);

  return `
    <svg class="gauge-svg" viewBox="0 0 ${size} ${size}" aria-label="额度余量仪表盘">
      <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" stroke="var(--bg-tertiary)" stroke-width="10" />
      <circle
        cx="${cx}" cy="${cy}" r="${rOuter}"
        fill="none"
        stroke="var(--accent-info)"
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray="${currentDash.toFixed(1)} ${cOuter.toFixed(1)}"
        transform="rotate(-90 ${cx} ${cy})"
      />
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="none" stroke="var(--bg-tertiary)" stroke-width="7" opacity="0.7" />
      <circle
        cx="${cx}" cy="${cy}" r="${rInner}"
        fill="none"
        stroke="${color}"
        stroke-width="7"
        stroke-linecap="round"
        stroke-dasharray="${predDash.toFixed(1)} ${cInner.toFixed(1)}"
        transform="rotate(-90 ${cx} ${cy})"
      />
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="var(--text-primary)" font-size="22" font-weight="800" font-family="var(--font-mono)">
        ${forecast.currentRemainingPct.toFixed(1)}%
      </text>
      <text x="${cx}" y="${cy + 11}" text-anchor="middle" fill="var(--text-secondary)" font-size="10">
        当前剩余 (外环)
      </text>
      <text x="${cx}" y="${cy + 27}" text-anchor="middle" fill="${color}" font-size="11" font-weight="700" font-family="var(--font-mono)">
        刷新剩 ${forecast.predictedRemainingPctAtReset.toFixed(1)}%
      </text>
    </svg>
  `;
}

function renderTimelineSvg(pool: PoolSnapshot): string {
  const pts = pool.timeline;
  if (!pts || pts.length < 2) {
    return '<p style="color:var(--text-secondary);font-size:12px;">暂无时间线样本。</p>';
  }

  const W = 680;
  const H = 180;
  const padL = 36;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const minTs = pts[0].timestampMs;
  const maxTs = Math.max(minTs + 60_000, pts[pts.length - 1].timestampMs);

  const xOf = (ts: number) => padL + ((ts - minTs) / (maxTs - minTs)) * plotW;
  const yOf = (pct: number) => padT + ((100 - Math.max(0, Math.min(100, pct))) / 100) * plotH;

  const histPts = pts.filter((p) => !p.projected);
  const projPts = pts.filter((p) => p.projected);
  const lastHist = histPts[histPts.length - 1];

  const histLine = histPts.map((p) => `${xOf(p.timestampMs).toFixed(1)},${yOf(p.remainingPct).toFixed(1)}`).join(' ');
  const projChain = lastHist ? [lastHist, ...projPts] : projPts;
  const projLine = projChain.map((p) => `${xOf(p.timestampMs).toFixed(1)},${yOf(p.remainingPct).toFixed(1)}`).join(' ');

  let bandPoly = '';
  if (projChain.length >= 2) {
    const upper = projChain.map((p) => {
      const v = p.optimisticPct ?? p.remainingPct;
      return `${xOf(p.timestampMs).toFixed(1)},${yOf(v).toFixed(1)}`;
    });
    const lower = [...projChain].reverse().map((p) => {
      const v = p.conservativePct ?? p.remainingPct;
      return `${xOf(p.timestampMs).toFixed(1)},${yOf(v).toFixed(1)}`;
    });
    bandPoly = [...upper, ...lower].join(' ');
  }

  const nowX = lastHist ? xOf(lastHist.timestampMs) : padL;
  const resetX = xOf(maxTs);
  const warnY = yOf(snapshot?.config.alerts.warningRemainingPct ?? 20);
  const fColor = statusColor(pool.shortWindow.status);

  const yTicks = [100, 75, 50, 25, 0]
    .map((pct) => {
      const y = yOf(pct);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border-secondary)" stroke-width="1" />
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--text-tertiary)" font-size="10" font-family="var(--font-mono)">${pct}%</text>
      `;
    })
    .join('');

  const xLabelIndices = [0, Math.floor(pts.length / 2), pts.length - 1];
  const xLabels = xLabelIndices
    .map((idx) => {
      const p = pts[idx];
      if (!p) return '';
      return `<text x="${xOf(p.timestampMs).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--text-tertiary)" font-size="10" font-family="var(--font-mono)">${escapeHtml(p.label)}</text>`;
    })
    .join('');

  const hoverDots = pts
    .map((p) => {
      const cx = xOf(p.timestampMs).toFixed(1);
      const cy = yOf(p.remainingPct).toFixed(1);
      const tip = p.projected
        ? `${p.label} (预测) · 预期 ${p.remainingPct.toFixed(1)}% (区间 ${(p.conservativePct ?? p.remainingPct).toFixed(1)}% ~ ${(p.optimisticPct ?? p.remainingPct).toFixed(1)}%)`
        : `${p.label} (历史) · 余量 ${p.remainingPct.toFixed(1)}%`;
      return `<circle cx="${cx}" cy="${cy}" r="6" fill="transparent"><title>${escapeHtml(tip)}</title></circle>`;
    })
    .join('');

  return `
    <div class="chart-container">
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${yTicks}
        <line x1="${padL}" y1="${warnY.toFixed(1)}" x2="${W - padR}" y2="${warnY.toFixed(1)}" stroke="var(--accent-warning)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />
        ${bandPoly ? `<polygon points="${bandPoly}" fill="${fColor}" opacity="0.16" />` : ''}
        ${histLine ? `<polyline fill="none" stroke="var(--accent-info)" stroke-width="2.5" points="${histLine}" />` : ''}
        ${projLine ? `<polyline fill="none" stroke="${fColor}" stroke-width="2.2" stroke-dasharray="5 4" points="${projLine}" />` : ''}
        <line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${H - padB}" stroke="var(--text-secondary)" stroke-width="1" stroke-dasharray="2 2" />
        <text x="${(nowX + 4).toFixed(1)}" y="${padT + 10}" fill="var(--text-secondary)" font-size="10">现在</text>
        <line x1="${resetX.toFixed(1)}" y1="${padT}" x2="${resetX.toFixed(1)}" y2="${H - padB}" stroke="var(--accent-success)" stroke-width="1.2" stroke-dasharray="3 2" />
        <text x="${(resetX - 4).toFixed(1)}" y="${padT + 10}" text-anchor="end" fill="var(--accent-success)" font-size="10">下次刷新</text>
        ${
          lastHist
            ? `<circle cx="${nowX.toFixed(1)}" cy="${yOf(lastHist.remainingPct).toFixed(1)}" r="4" fill="var(--accent-info)" />`
            : ''
        }
        ${hoverDots}
        ${xLabels}
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--accent-info)"></span>历史余量轨迹</span>
        <span class="legend-item"><span class="legend-swatch" style="background:${fColor};border-top:2px dashed ${fColor}"></span>占空比融合预测</span>
        <span class="legend-item"><span class="legend-swatch" style="background:${fColor};opacity:0.35;height:8px"></span>P10–P90 预测置信带</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--accent-warning)"></span>预警线 (${snapshot?.config.alerts.warningRemainingPct ?? 20}%)</span>
      </div>
    </div>
  `;
}

function renderHourlyBarsSvg(buckets: HourlyBucket[]): string {
  if (!buckets || buckets.length === 0) {
    return '<p style="color:var(--text-secondary)">暂无 24 小时统计数据。</p>';
  }
  const maxTok = Math.max(1, ...buckets.map((b) => b.totalTokens));
  const W = 680;
  const H = 160;
  const padL = 42;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const barSlot = plotW / buckets.length;
  const barW = Math.max(6, barSlot - 6);

  const bars = buckets
    .map((b, i) => {
      const x = padL + i * barSlot + (barSlot - barW) / 2;
      const totalH = (b.totalTokens / maxTok) * plotH;
      const cacheH = b.totalTokens > 0 ? (b.cacheReadTokens / b.totalTokens) * totalH : 0;
      const freshAndOutH = Math.max(0, totalH - cacheH);
      const yTop = padT + plotH - totalH;
      const yCache = padT + plotH - cacheH;
      const showLabel = i % 3 === 0 || i === buckets.length - 1;

      return `
        <g>
          <title>${escapeHtml(b.label)} · 总计 ${formatNumber(b.totalTokens)} (Fresh ${formatNumber(b.inputTokens)} / Cache ${formatNumber(b.cacheReadTokens)} / Out ${formatNumber(b.outputTokens)} · ${b.turns}轮)</title>
          ${freshAndOutH > 0 ? `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${freshAndOutH.toFixed(1)}" rx="2" fill="var(--accent-info)" />` : ''}
          ${cacheH > 0 ? `<rect x="${x.toFixed(1)}" y="${yCache.toFixed(1)}" width="${barW.toFixed(1)}" height="${cacheH.toFixed(1)}" rx="2" fill="var(--accent-success)" opacity="0.85" />` : ''}
          ${b.totalTokens === 0 ? `<rect x="${x.toFixed(1)}" y="${(padT + plotH - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" fill="var(--border-secondary)" />` : ''}
          ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--text-tertiary)" font-size="9.5" font-family="var(--font-mono)">${escapeHtml(b.label.slice(0, 2))}</text>` : ''}
        </g>
      `;
    })
    .join('');

  return `
    <div class="chart-container">
      <svg class="chart-svg" style="height:160px" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--border-secondary)" stroke-width="1" />
        <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="var(--border-secondary)" stroke-width="1" stroke-dasharray="3 3" />
        <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border-primary)" stroke-width="1" />
        <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" fill="var(--text-tertiary)" font-size="9.5" font-family="var(--font-mono)">${formatNumber(maxTok)}</text>
        <text x="${padL - 5}" y="${padT + plotH / 2 + 3}" text-anchor="end" fill="var(--text-tertiary)" font-size="9.5" font-family="var(--font-mono)">${formatNumber(maxTok / 2)}</text>
        <text x="${padL - 5}" y="${padT + plotH + 3}" text-anchor="end" fill="var(--text-tertiary)" font-size="9.5" font-family="var(--font-mono)">0</text>
        ${bars}
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--accent-info);height:8px"></span>Fresh Input + Output</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--accent-success);height:8px"></span>Prompt Cache Read (低权重)</span>
      </div>
    </div>
  `;
}

function renderOverview(pool: PoolSnapshot, snap: UsageSnapshot): string {
  const forecast = selectedWindow === 'short' ? pool.shortWindow : pool.weeklyWindow;
  const remainingMs = Math.max(0, forecast.nextResetAtMs - Date.now());

  const alertText =
    forecast.projectedLockoutMinutes && forecast.projectedLockoutMinutes > 0
      ? `按占空比融合速率 (${pool.burnRate.blendedPctPerHour}%/h)，预计 ${forecast.runwayMinutes} 分钟后耗尽，可能提前断档约 ${forecast.projectedLockoutMinutes} 分钟！建议控制在 ≤ ${forecast.safeBurnRatePctPerHour}%/h (${formatNumber(forecast.safeTokensPerMinute)} tok/min)。`
      : `按占空比融合速率 (${pool.burnRate.blendedPctPerHour}%/h)，下次刷新时预计仍剩余 ${forecast.predictedRemainingPctAtReset.toFixed(1)}%（若不间断全速连跑则预计剩 ${forecast.activePacePredictedRemainingPct.toFixed(1)}%）。`;

  const calBadge = forecast.calibrated
    ? `<span class="badge info">已锚点校准 · 1%≈${formatNumber(forecast.tokensPerPct)} 加权Tok</span>`
    : `<span class="badge">估算模式 (${snap.plan}) · 建议对照 /usage 校准</span>`;

  const t = snap.totals;
  const acc = snap.calibrationAccuracy;

  return `
    <div class="card">
      <div class="card-title">
        <span>${escapeHtml(pool.displayName)} · ${selectedWindow === 'short' ? '5 小时滚动短窗' : '7 天周度基线'} 刷新预告</span>
        ${calBadge}
      </div>
      <div class="hero-grid">
        <div class="gauge-wrap">
          ${renderGaugeSvg(forecast)}
          <span class="badge ${forecast.status}">${statusLabel(forecast.status)} · 置信度 ${forecast.confidence.toUpperCase()}</span>
        </div>
        <div class="hero-metrics">
          <div class="forecast-headline">
            <span style="color:var(--text-secondary);font-size:12px;">下次刷新时预告余下:</span>
            <span class="forecast-big ${forecast.status}">${forecast.predictedRemainingPctAtReset.toFixed(1)}%</span>
            <span class="badge">区间 ${forecast.predictedRange.conservative.toFixed(1)}% ~ ${forecast.predictedRange.optimistic.toFixed(1)}%</span>
          </div>

          <div class="sub-metrics">
            <div class="mini-box">
              <span class="mini-label">距下次刷新倒计时</span>
              <span class="mini-value" id="countdown-clock">${formatDurationMs(remainingMs)}</span>
              <span class="mini-sub">刷新时刻 ${formatLocalTime(forecast.nextResetAtMs)}</span>
            </div>
            <div class="mini-box">
              <span class="mini-label">融合燃烧速率 (占空比 ${Math.round(pool.burnRate.effectiveDutyCycle * 100)}%)</span>
              <span class="mini-value">${pool.burnRate.blendedPctPerHour.toFixed(2)}%/h</span>
              <span class="mini-sub">全速 ${pool.burnRate.rawActivePctPerHour.toFixed(1)}%/h · ${formatNumber(pool.burnRate.tokensPerMinute)} tok/m</span>
            </div>
            <div class="mini-box">
              <span class="mini-label">全速连跑预告余量</span>
              <span class="mini-value">${forecast.activePacePredictedRemainingPct.toFixed(1)}%</span>
              <span class="mini-sub">100% 不间断编码极限参考</span>
            </div>
            <div class="mini-box">
              <span class="mini-label">安全续航预算</span>
              <span class="mini-value">${forecast.safeBurnRatePctPerHour.toFixed(1)}%/h</span>
              <span class="mini-sub">保留 ${snap.config.safetyBufferPct}% 缓冲 (${formatNumber(forecast.safeTokensPerMinute)} tok/m)</span>
            </div>
          </div>

          <div class="alert-banner ${forecast.status}">
            <span>${escapeHtml(alertText)}</span>
            ${canSendMessage ? `<button type="button" id="btn-send-chat" class="btn" style="flex-shrink:0">发送到对话</button>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <span class="kpi-label">累计总消耗 Tokens (All-Time)</span>
        <span class="kpi-value">${formatNumber(t.allTime.totalTokens)}</span>
        <span class="kpi-meta">${t.allTime.turns} 轮推理 · ${t.allTime.toolCalls} 次工具调用</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">当前 5h 窗口 Tokens</span>
        <span class="kpi-value">${formatNumber(t.shortWindow.totalTokens)}</span>
        <span class="kpi-meta">加权 ${formatNumber(t.shortWindow.weightedTokens)} · 今日 ${formatNumber(t.today.totalTokens)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Prompt 缓存命中率</span>
        <span class="kpi-value">${t.allTime.cacheHitRate.toFixed(1)}%</span>
        <span class="kpi-meta">读取 ${formatNumber(t.allTime.cacheReadTokens)} · 省下 ${formatNumber(t.allTime.savedByCacheTokens)}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">等效 API 净成本 / 缓存省钱</span>
        <span class="kpi-value">${formatUsd(t.allTime.cost.estimatedApiCostUsd)}</span>
        <span class="kpi-meta">无缓存 ${formatUsd(t.allTime.cost.withoutCacheCostUsd)} · 已省 ${formatUsd(t.allTime.cost.cacheSavingsUsd)}</span>
      </div>
    </div>

    ${
      snap.recommendations.length > 0
        ? `
      <div class="card">
        <div class="card-title"><span>智能省额与上下文健康建议</span></div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${snap.recommendations
            .map(
              (r) => `
            <div class="alert-banner ${r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'healthy'}" style="justify-content:flex-start;align-items:flex-start;flex-direction:column;gap:2px;">
              <strong>${escapeHtml(r.title)}</strong>
              <span style="opacity:0.92">${escapeHtml(r.detail)}</span>
            </div>`,
            )
            .join('')}
        </div>
      </div>`
        : ''
    }

    <div class="card">
      <div class="card-title">
        <span>额度消耗曲线与刷新余量预测轨迹 (${escapeHtml(pool.displayName)})</span>
        <span style="font-weight:400;text-transform:none;">活跃 ${pool.burnRate.activeMinutesInWindow}m / 已过 ${pool.burnRate.elapsedMinutesInWindow}m · 静默 ${pool.burnRate.idleMinutesSinceLastEvent}m</span>
      </div>
      ${renderTimelineSvg(pool)}
    </div>

    <div class="card">
      <div class="card-title">
        <span>一键锚点校准 (对照 Antigravity 原生 /usage 或 Settings → Models)</span>
        <span style="font-weight:400;text-transform:none;">${acc.totalCalibrations > 0 && acc.meanAbsoluteErrorPct !== null ? `已校准 ${acc.totalCalibrations} 次 · 平均误差 MAE ${acc.meanAbsoluteErrorPct}%` : '同周期校准 2 次自动学习 1% 对应 Token 系数'}</span>
      </div>
      <form id="cal-form" class="calibration-form">
        <div class="field">
          <label for="cal-pool">模型池</label>
          <select id="cal-pool">
            ${snap.pools
              .map(
                (p) =>
                  `<option value="${p.poolId}" ${p.poolId === pool.poolId ? 'selected' : ''}>${escapeHtml(p.displayName)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="cal-window">窗口</label>
          <select id="cal-window">
            <option value="short" ${selectedWindow === 'short' ? 'selected' : ''}>5h 短窗</option>
            <option value="weekly" ${selectedWindow === 'weekly' ? 'selected' : ''}>7d 周窗</option>
          </select>
        </div>
        <div class="field">
          <label for="cal-pct">当前剩余 (%)</label>
          <input id="cal-pct" type="number" min="0" max="100" step="0.5" value="${forecast.currentRemainingPct.toFixed(1)}" required />
        </div>
        <div class="field">
          <label for="cal-mins">距下次刷新 (分钟)</label>
          <input id="cal-mins" type="number" min="1" max="20160" step="1" value="${Math.max(1, Math.round(remainingMs / 60000))}" required />
        </div>
        <button type="submit" class="btn primary" ${isBusy ? 'disabled' : ''}>保存校准</button>
        <button type="button" id="cal-reset-btn" class="btn" ${isBusy ? 'disabled' : ''}>重置校准</button>
      </form>
      ${
        acc.recentRecords.length > 0
          ? `
        <div class="table-wrap" style="margin-top:10px;">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>池 / 窗</th>
                <th class="num">校准前预测</th>
                <th class="num">/usage 实测</th>
                <th class="num">偏差</th>
                <th class="num">1% 系数</th>
              </tr>
            </thead>
            <tbody>
              ${acc.recentRecords
                .slice(0, 5)
                .map(
                  (r) => `
                <tr>
                  <td>${formatLocalTime(r.timestampMs)}</td>
                  <td><code>${escapeHtml(r.poolId)}/${r.windowKind}</code></td>
                  <td class="num">${r.predictedPctBefore.toFixed(1)}%</td>
                  <td class="num"><strong>${r.actualPct.toFixed(1)}%</strong></td>
                  <td class="num">${r.absoluteErrorPct.toFixed(1)}%</td>
                  <td class="num">${formatNumber(r.tokensPerPctAfter)}${r.learnedUpdated ? ' ✨' : ''}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>`
          : ''
      }
    </div>
  `;
}

function renderSimulateTab(pool: PoolSnapshot, snap: UsageSnapshot): string {
  return `
    <div class="card">
      <div class="card-title">
        <span>What-If 负载模拟推演器</span>
        <span>预测“接下来再跑 N 轮 / M 分钟，或把部分任务分流至 Flash”后的剩余额度</span>
      </div>
      <form id="sim-form" class="calibration-form">
        <div class="field">
          <label for="sim-pool">目标模型池</label>
          <select id="sim-pool">
            ${snap.pools
              .map(
                (p) =>
                  `<option value="${p.poolId}" ${p.poolId === pool.poolId ? 'selected' : ''}>${escapeHtml(p.displayName)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="sim-turns">计划新增推理轮次</label>
          <input id="sim-turns" type="number" min="0" max="500" value="${simTurns}" />
        </div>
        <div class="field">
          <label for="sim-mins">或新增活跃编码 (分钟)</label>
          <input id="sim-mins" type="number" min="0" max="600" value="${simMinutes}" />
        </div>
        <div class="field">
          <label for="sim-offload">分流至 Gemini Flash (%)</label>
          <input id="sim-offload" type="number" min="0" max="100" step="5" value="${simOffloadPct}" />
        </div>
        <button type="submit" class="btn primary" ${isBusy ? 'disabled' : ''}>运行模拟推演</button>
      </form>
    </div>

    ${
      simulationResult
        ? `
      <div class="card">
        <div class="card-title">
          <span>推演结果 (${escapeHtml(simulationResult.poolId)} · ${simulationResult.windowKind === 'short' ? '5h短窗' : '7d周窗'})</span>
          <span class="badge ${simulationResult.survivesUntilReset ? 'healthy' : 'critical'}">${simulationResult.survivesUntilReset ? '纯主力池可撑到刷新' : '纯主力池将触底'}</span>
        </div>
        <div class="sub-metrics" style="margin-bottom:10px;">
          <div class="mini-box">
            <span class="mini-label">当前余量基线</span>
            <span class="mini-value">${simulationResult.baselineRemainingPct.toFixed(1)}%</span>
            <span class="mini-sub">计划新增 ${formatNumber(simulationResult.simulatedAddedWeightedTokens)} 加权Tok</span>
          </div>
          <div class="mini-box">
            <span class="mini-label">全量主力池执行后</span>
            <span class="mini-value" style="color:${simulationResult.survivesUntilReset ? 'var(--accent-success)' : 'var(--accent-danger)'}">${simulationResult.remainingAfterWorkloadPct.toFixed(1)}%</span>
            <span class="mini-sub">消耗 ${simulationResult.simulatedAddedPct.toFixed(1)}%</span>
          </div>
          <div class="mini-box">
            <span class="mini-label">分流 ${simulationResult.offloadToFlashPct}% 至 Flash 后</span>
            <span class="mini-value" style="color:var(--accent-info)">${simulationResult.withOffloadRemainingPct.toFixed(1)}%</span>
            <span class="mini-sub">为主力池省下 ${simulationResult.savedPrimaryPct.toFixed(1)}%</span>
          </div>
          <div class="mini-box">
            <span class="mini-label">对 Flash 池消耗</span>
            <span class="mini-value">${simulationResult.flashImpactPct.toFixed(1)}%</span>
            <span class="mini-sub">低倍率高效分流</span>
          </div>
        </div>
        <div class="alert-banner ${simulationResult.withOffloadRemainingPct <= snap.config.safetyBufferPct ? 'warning' : 'healthy'}">
          <span>${escapeHtml(simulationResult.recommendation)}</span>
        </div>
      </div>`
        : `<div class="card"><p style="color:var(--text-secondary)">点击上方「运行模拟推演」，即可基于你的历史单轮平均 Token 消耗模拟未来负载与 Flash 分流收益。</p></div>`
    }
  `;
}

function renderTrendsTab(snap: UsageSnapshot): string {
  return `
    <div class="card">
      <div class="card-title">
        <span>过去 24 小时 Token 消耗分布</span>
        <span>悬停柱体查看各时段详细拆分</span>
      </div>
      ${renderHourlyBarsSvg(snap.hourlyTrend24h)}
    </div>

    <div class="card">
      <div class="card-title">
        <span>最近 7 天每日消耗与等效费用趋势</span>
        <div style="display:flex;gap:6px;">
          <button type="button" id="btn-export-md" class="btn" ${isBusy ? 'disabled' : ''}>生成 Markdown 报告</button>
          <button type="button" id="btn-export-csv" class="btn" ${isBusy ? 'disabled' : ''}>生成 CSV 表格</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th class="num">总 Tokens</th>
              <th class="num">加权 Tokens</th>
              <th class="num">缓存命中率</th>
              <th class="num">等效 API 费</th>
              <th class="num">轮次</th>
            </tr>
          </thead>
          <tbody>
            ${snap.dailyTrend7d
              .slice()
              .reverse()
              .map(
                (d) => `
              <tr>
                <td><code>${escapeHtml(d.dateKey)}</code></td>
                <td class="num"><strong>${formatNumber(d.totalTokens)}</strong></td>
                <td class="num">${formatNumber(d.weightedTokens)}</td>
                <td class="num">${d.cacheHitRate.toFixed(1)}%</td>
                <td class="num">${formatUsd(d.estimatedApiCostUsd)}</td>
                <td class="num">${d.turns}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    ${
      exportedReportText
        ? `
      <div class="card">
        <div class="card-title">
          <span>导出报告预览</span>
          <button type="button" id="btn-copy-report" class="btn primary">复制到剪贴板</button>
        </div>
        <textarea id="report-preview" readonly style="width:100%;min-height:180px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-primary);border-radius:8px;padding:10px;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(exportedReportText)}</textarea>
      </div>`
        : ''
    }
  `;
}

function renderConversationsTab(snap: UsageSnapshot): string {
  return `
    ${
      snap.projects.length > 0
        ? `
      <div class="card">
        <div class="card-title">
          <span>按工作区 / 项目聚合消耗 (${snap.projects.length} 个项目)</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>项目名称</th>
                <th class="num">会话数</th>
                <th>主力模型</th>
                <th class="num">总 Tokens</th>
                <th class="num">缓存命中</th>
                <th class="num">等效费用</th>
                <th class="num">占比</th>
              </tr>
            </thead>
            <tbody>
              ${snap.projects
                .map(
                  (p) => `
                <tr>
                  <td><strong>${escapeHtml(p.projectName)}</strong></td>
                  <td class="num">${p.conversationCount}</td>
                  <td><code>${escapeHtml(p.topModel)}</code></td>
                  <td class="num"><strong>${formatNumber(p.tokens.totalTokens)}</strong></td>
                  <td class="num">${p.tokens.cacheHitRate.toFixed(1)}%</td>
                  <td class="num">${formatUsd(p.tokens.cost.estimatedApiCostUsd)}</td>
                  <td class="num">${p.shareOfAllTimePct.toFixed(1)}%</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`
        : ''
    }

    <div class="card">
      <div class="card-title">
        <span>会话 Token 消耗排行与上下文膨胀诊断 (共 ${snap.conversations.length} 个会话)</span>
        <span>来源文件 ${snap.scannedFilesCount} 个</span>
      </div>
      ${
        snap.conversations.length === 0
          ? '<p style="color:var(--text-secondary)">尚未扫描到包含 Token 记录的 Antigravity 会话。</p>'
          : `<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>会话标题</th>
                    <th>项目</th>
                    <th class="num">总 Tokens</th>
                    <th class="num">峰值上下文</th>
                    <th class="num">命中率</th>
                    <th class="num">等效费</th>
                  </tr>
                </thead>
                <tbody>
                  ${snap.conversations
                    .slice(0, 30)
                    .map(
                      (c) => `
                    <tr>
                      <td class="truncate" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</td>
                      <td><span class="badge">${escapeHtml(c.projectName)}</span></td>
                      <td class="num"><strong>${formatNumber(c.tokens.totalTokens)}</strong></td>
                      <td class="num">${formatNumber(c.peakContextTokens)}${c.contextBloatRisk ? ' <span class="badge warning">/compact</span>' : ''}</td>
                      <td class="num">${c.tokens.cacheHitRate.toFixed(1)}%</td>
                      <td class="num">${formatUsd(c.tokens.cost.estimatedApiCostUsd)}</td>
                    </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    </div>
  `;
}

function renderModelsTab(snap: UsageSnapshot): string {
  return `
    <div class="card">
      <div class="card-title"><span>分模型 Token 与等效费用统计</span></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>所属池</th>
              <th class="num">轮次</th>
              <th class="num">总 Tokens</th>
              <th class="num">缓存命中</th>
              <th class="num">等效 API 费</th>
              <th class="num">占比</th>
            </tr>
          </thead>
          <tbody>
            ${snap.models
              .map(
                (m) => `
              <tr>
                <td><code>${escapeHtml(m.model)}</code></td>
                <td><span class="badge">${escapeHtml(m.poolId)}</span></td>
                <td class="num">${m.tokens.turns}</td>
                <td class="num"><strong>${formatNumber(m.tokens.totalTokens)}</strong></td>
                <td class="num">${m.tokens.cacheHitRate.toFixed(1)}%</td>
                <td class="num">${formatUsd(m.tokens.cost.estimatedApiCostUsd)}</td>
                <td class="num">${m.shareOfAllTimePct.toFixed(1)}%</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span>高频 Agent 工具调用 Top 15</span></div>
      ${
        snap.topTools.length === 0
          ? '<p style="color:var(--text-secondary)">暂无工具调用记录。</p>'
          : `<div style="display:flex;flex-direction:column;gap:8px;">
              ${snap.topTools
                .map(
                  (t) => `
                <div style="display:grid;grid-template-columns:160px 1fr 70px;gap:10px;align-items:center;">
                  <code class="truncate">${escapeHtml(t.name)}</code>
                  <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, t.sharePct)}%"></div></div>
                  <span style="text-align:right;font-family:var(--font-mono);font-size:12px;">${t.calls} (${t.sharePct}%)</span>
                </div>`,
                )
                .join('')}
            </div>`
      }
    </div>
  `;
}

function renderSettingsTab(snap: UsageSnapshot): string {
  const cfg = snap.config;
  return `
    <div class="card">
      <div class="card-title"><span>套餐预设、占空比、预警与桌面通知配置</span></div>
      <form id="settings-form">
        <div class="settings-grid">
          <div class="field">
            <label for="cfg-plan">Antigravity 订阅套餐</label>
            <select id="cfg-plan">
              <option value="free" ${cfg.plan === 'free' ? 'selected' : ''}>Free</option>
              <option value="ai-pro" ${cfg.plan === 'ai-pro' ? 'selected' : ''}>Google AI Pro</option>
              <option value="ai-ultra" ${cfg.plan === 'ai-ultra' ? 'selected' : ''}>Google AI Ultra</option>
              <option value="custom" ${cfg.plan === 'custom' ? 'selected' : ''}>Custom 自定义</option>
            </select>
          </div>
          <div class="field">
            <label for="cfg-short-min">短窗口周期 (分钟)</label>
            <input id="cfg-short-min" type="number" min="30" max="1440" value="${cfg.shortWindowMinutes}" />
          </div>
          <div class="field">
            <label for="cfg-duty">活跃占空比先验 (0.15–1.0)</label>
            <input id="cfg-duty" type="number" min="0.15" max="1" step="0.05" value="${cfg.dutyCyclePrior}" />
          </div>
          <div class="field">
            <label for="cfg-warn">预警阈值 (剩余 %)</label>
            <input id="cfg-warn" type="number" min="5" max="80" value="${cfg.alerts.warningRemainingPct}" />
          </div>
          <div class="field">
            <label for="cfg-crit">高危阈值 (剩余 %)</label>
            <input id="cfg-crit" type="number" min="1" max="50" value="${cfg.alerts.criticalRemainingPct}" />
          </div>
          <div class="field">
            <label for="cfg-buffer">安全缓冲预留 (%)</label>
            <input id="cfg-buffer" type="number" min="0" max="30" value="${cfg.safetyBufferPct}" />
          </div>
          <div class="field">
            <label for="cfg-alerts">PostInvocation 对话内预警</label>
            <select id="cfg-alerts">
              <option value="true" ${cfg.alerts.enabled ? 'selected' : ''}>已开启</option>
              <option value="false" ${!cfg.alerts.enabled ? 'selected' : ''}>已关闭</option>
            </select>
          </div>
          <div class="field">
            <label for="cfg-desktop">原生桌面低额弹窗通知</label>
            <select id="cfg-desktop">
              <option value="true" ${cfg.alerts.desktopNotification ? 'selected' : ''}>已开启</option>
              <option value="false" ${!cfg.alerts.desktopNotification ? 'selected' : ''}>已关闭</option>
            </select>
          </div>
          <div class="field">
            <label for="cfg-pro-budget">Pro/Neon 5h 加权预算</label>
            <input id="cfg-pro-budget" type="number" min="50000" step="50000" value="${cfg.poolBudgets['gemini-pro'].shortWeightedTokens}" />
          </div>
          <div class="field">
            <label for="cfg-flash-budget">Flash 5h 加权预算</label>
            <input id="cfg-flash-budget" type="number" min="50000" step="100000" value="${cfg.poolBudgets['gemini-flash'].shortWeightedTokens}" />
          </div>
        </div>
        <button type="submit" class="btn primary" ${isBusy ? 'disabled' : ''}>保存配置</button>
      </form>
    </div>
  `;
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;

  if (!snapshot) {
    root.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>${escapeHtml(statusNotice || '正在等待 Antigravity Usage Monitor 数据快照...')}</p>
      </div>
    `;
    return;
  }

  const pool = getSelectedPool()!;
  const activeForecast = selectedWindow === 'short' ? pool.shortWindow : pool.weeklyWindow;

  let bodyHtml = '';
  if (activeTab === 'overview') bodyHtml = renderOverview(pool, snapshot);
  else if (activeTab === 'simulate') bodyHtml = renderSimulateTab(pool, snapshot);
  else if (activeTab === 'trends') bodyHtml = renderTrendsTab(snapshot);
  else if (activeTab === 'conversations') bodyHtml = renderConversationsTab(snapshot);
  else if (activeTab === 'models') bodyHtml = renderModelsTab(snapshot);
  else bodyHtml = renderSettingsTab(snapshot);

  root.innerHTML = `
    <header class="header">
      <div class="header-left">
        <span class="brand-dot ${activeForecast.status}"></span>
        <span class="title">Antigravity Usage Monitor</span>
        <span class="badge">${escapeHtml(snapshot.plan.toUpperCase())}</span>
        ${statusNotice ? `<span class="toast">${escapeHtml(statusNotice)}</span>` : ''}
      </div>
      <div class="header-actions">
        <button id="btn-auto" class="btn ${autoRefresh ? 'active' : ''}">自动刷新: ${autoRefresh ? '开' : '关'}</button>
        <button id="btn-refresh" class="btn" ${isBusy ? 'disabled' : ''}>立即刷新</button>
      </div>
    </header>

    <div class="controls-bar">
      <div class="pill-group" role="tablist">
        <button class="pill-btn ${activeTab === 'overview' ? 'active' : ''}" data-tab="overview">额度与预测</button>
        <button class="pill-btn ${activeTab === 'simulate' ? 'active' : ''}" data-tab="simulate">模拟推演</button>
        <button class="pill-btn ${activeTab === 'trends' ? 'active' : ''}" data-tab="trends">24h/7d 趋势</button>
        <button class="pill-btn ${activeTab === 'conversations' ? 'active' : ''}" data-tab="conversations">项目与会话</button>
        <button class="pill-btn ${activeTab === 'models' ? 'active' : ''}" data-tab="models">模型与工具</button>
        <button class="pill-btn ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">配置</button>
      </div>

      ${
        activeTab === 'overview'
          ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <div class="pill-group">
            ${snapshot.pools
              .map(
                (p) =>
                  `<button class="pill-btn ${p.poolId === pool.poolId ? 'active' : ''}" data-pool="${p.poolId}">${escapeHtml(p.displayName)}</button>`,
              )
              .join('')}
          </div>
          <div class="pill-group">
            <button class="pill-btn ${selectedWindow === 'short' ? 'active' : ''}" data-win="short">5h 短窗</button>
            <button class="pill-btn ${selectedWindow === 'weekly' ? 'active' : ''}" data-win="weekly">7d 周窗</button>
          </div>
        </div>`
          : ''
      }
    </div>

    ${bodyHtml}
  `;

  bindHandlers();
}

async function refreshSnapshot(): Promise<void> {
  if (!isBackendReady() || isBusy) return;
  isBusy = true;
  render();
  try {
    const structured = await callBackend<UsageSnapshot>('app_get_snapshot', {});
    if (structured) {
      snapshot = structured;
      statusNotice = `已更新 ${formatLocalTime(Date.now())}`;
    }
  } catch (err) {
    statusNotice = `刷新失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    isBusy = false;
    render();
  }
}

async function triggerExport(format: 'markdown' | 'csv'): Promise<void> {
  if (!isBackendReady() || isBusy) return;
  isBusy = true;
  statusNotice = `正在生成 ${format.toUpperCase()} 报告...`;
  render();
  try {
    const sc = await callBackend<{ report?: string }>('app_export_report', { format });
    if (sc?.report) {
      exportedReportText = sc.report;
      statusNotice = `已生成 ${format.toUpperCase()} 报告`;
    }
  } catch (err) {
    statusNotice = `导出失败: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    isBusy = false;
    render();
  }
}

function bindHandlers(): void {
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    void refreshSnapshot();
  });

  document.getElementById('btn-auto')?.addEventListener('click', () => {
    autoRefresh = !autoRefresh;
    render();
  });

  document.getElementById('btn-send-chat')?.addEventListener('click', async () => {
    if (!canSendMessage || !snapshot) return;
    const pool = getSelectedPool();
    if (!pool) return;
    const f = selectedWindow === 'short' ? pool.shortWindow : pool.weeklyWindow;
    const summaryText = `请结合当前额度状态帮我规划接下来的开发节奏：${pool.displayName} 当前剩余 ${f.currentRemainingPct.toFixed(1)}%，下次刷新预计剩余 ${f.predictedRemainingPctAtReset.toFixed(1)}%，安全节奏 ≤ ${f.safeBurnRatePctPerHour.toFixed(1)}%/h，累计消耗 ${formatNumber(snapshot.totals.allTime.totalTokens)} tokens（缓存命中率 ${snapshot.totals.allTime.cacheHitRate.toFixed(1)}%）。`;
    try {
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: summaryText }],
      });
      statusNotice = '已将额度状态发送至当前对话';
      render();
    } catch {
      statusNotice = '当前视图不支持向对话发送消息';
      render();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab as ActiveTab;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-pool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPoolId = btn.dataset.pool as PoolId;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-win]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedWindow = btn.dataset.win as WindowKind;
      render();
    });
  });

  document.getElementById('btn-export-md')?.addEventListener('click', () => {
    void triggerExport('markdown');
  });

  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    void triggerExport('csv');
  });

  document.getElementById('btn-copy-report')?.addEventListener('click', async () => {
    const el = document.getElementById('report-preview') as HTMLTextAreaElement | null;
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value);
      statusNotice = '报告已复制到剪贴板';
      render();
    } catch {
      el.select();
      statusNotice = '已选中文本，请按 Ctrl+C 复制';
      render();
    }
  });

  const simForm = document.getElementById('sim-form') as HTMLFormElement | null;
  simForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isBackendReady() || isBusy) return;
    const poolId = (document.getElementById('sim-pool') as HTMLSelectElement).value as PoolId;
    simTurns = Number((document.getElementById('sim-turns') as HTMLInputElement).value);
    simMinutes = Number((document.getElementById('sim-mins') as HTMLInputElement).value);
    simOffloadPct = Number((document.getElementById('sim-offload') as HTMLInputElement).value);

    isBusy = true;
    statusNotice = '正在运行 What-If 推演...';
    render();
    try {
      const sc = await callBackend<SimulationResult>('app_simulate', {
        poolId,
        windowKind: selectedWindow,
        additionalTurns: simTurns,
        additionalMinutes: simMinutes,
        offloadToFlashPct: simOffloadPct,
      });
      if (sc) {
        simulationResult = sc;
        statusNotice = '推演完成';
      }
    } catch (err) {
      statusNotice = `推演失败: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      isBusy = false;
      render();
    }
  });

  const calForm = document.getElementById('cal-form') as HTMLFormElement | null;
  calForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isBackendReady() || isBusy) return;
    const poolId = (document.getElementById('cal-pool') as HTMLSelectElement).value as PoolId;
    const windowKind = (document.getElementById('cal-window') as HTMLSelectElement).value as WindowKind;
    const remainingPct = Number((document.getElementById('cal-pct') as HTMLInputElement).value);
    const resetInMinutes = Number((document.getElementById('cal-mins') as HTMLInputElement).value);
    isBusy = true;
    statusNotice = '正在保存校准...';
    render();
    try {
      const sc = await callBackend<{
        snapshot: UsageSnapshot;
        learnedUpdated: boolean;
        newTokensPerPct: number;
        absoluteErrorPct: number;
      }>('app_calibrate', { poolId, windowKind, remainingPct, resetInMinutes });
      if (sc?.snapshot) {
        snapshot = sc.snapshot;
        selectedPoolId = poolId;
        selectedWindow = windowKind;
        statusNotice = sc.learnedUpdated
          ? `校准成功 (偏差 ${sc.absoluteErrorPct.toFixed(1)}%) · 自学习新系数 1%≈${formatNumber(sc.newTokensPerPct)}`
          : `锚点已保存 (校准前偏差 ${sc.absoluteErrorPct.toFixed(1)}%)`;
      }
    } catch (err) {
      statusNotice = `校准失败: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      isBusy = false;
      render();
    }
  });

  document.getElementById('cal-reset-btn')?.addEventListener('click', async () => {
    if (!isBackendReady() || isBusy) return;
    isBusy = true;
    statusNotice = '正在重置校准...';
    render();
    try {
      const sc = await callBackend<UsageSnapshot>('app_reset_calibration', {
        poolId: selectedPoolId,
        windowKind: selectedWindow,
      });
      if (sc) {
        snapshot = sc;
        statusNotice = '已重置当前窗口校准';
      }
    } catch (err) {
      statusNotice = `重置失败: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      isBusy = false;
      render();
    }
  });

  const settingsForm = document.getElementById('settings-form') as HTMLFormElement | null;
  settingsForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isBackendReady() || isBusy) return;
    const plan = (document.getElementById('cfg-plan') as HTMLSelectElement).value as PlanId;
    const shortWindowMinutes = Number((document.getElementById('cfg-short-min') as HTMLInputElement).value);
    const dutyCyclePrior = Number((document.getElementById('cfg-duty') as HTMLInputElement).value);
    const warningRemainingPct = Number((document.getElementById('cfg-warn') as HTMLInputElement).value);
    const criticalRemainingPct = Number((document.getElementById('cfg-crit') as HTMLInputElement).value);
    const safetyBufferPct = Number((document.getElementById('cfg-buffer') as HTMLInputElement).value);
    const alertsEnabled = (document.getElementById('cfg-alerts') as HTMLSelectElement).value === 'true';
    const desktopNotification = (document.getElementById('cfg-desktop') as HTMLSelectElement).value === 'true';
    const proShortBudget = Number((document.getElementById('cfg-pro-budget') as HTMLInputElement).value);
    const flashShortBudget = Number((document.getElementById('cfg-flash-budget') as HTMLInputElement).value);

    isBusy = true;
    statusNotice = '正在保存配置...';
    render();
    try {
      const payload: Record<string, unknown> = {
        plan,
        shortWindowMinutes,
        dutyCyclePrior,
        safetyBufferPct,
        warningRemainingPct,
        criticalRemainingPct,
        alertsEnabled,
        desktopNotification,
      };
      if (plan === 'custom') {
        payload.proShortBudget = proShortBudget;
        payload.flashShortBudget = flashShortBudget;
      }
      const sc = await callBackend<UsageSnapshot>('app_save_config', payload);
      if (sc) {
        snapshot = sc;
        statusNotice = '配置已保存并立即生效';
      }
    } catch (err) {
      statusNotice = `保存失败: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      isBusy = false;
      render();
    }
  });
}

app.ontoolinput = () => {
  statusNotice = '正在扫描本地 transcript.jsonl...';
  render();
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: UsageSnapshot | { snapshot?: UsageSnapshot } }).structuredContent;
  if (sc && 'pools' in sc) {
    snapshot = sc;
    selectedPoolId = sc.primaryPoolId;
    statusNotice = '';
    render();
  } else if (sc && 'snapshot' in sc && sc.snapshot) {
    snapshot = sc.snapshot;
    selectedPoolId = sc.snapshot.primaryPoolId;
    statusNotice = '';
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

let lastRolledOverResetAt = 0;

setInterval(() => {
  if (!snapshot || activeTab !== 'overview') return;
  const pool = getSelectedPool();
  if (!pool) return;
  const forecast = selectedWindow === 'short' ? pool.shortWindow : pool.weeklyWindow;
  const remaining = forecast.nextResetAtMs - Date.now();
  const clockEl = document.getElementById('countdown-clock');
  if (clockEl) {
    clockEl.textContent = formatDurationMs(Math.max(0, remaining));
  }
  // Automatically reload snapshot once when refresh countdown crosses 00:00:00
  if (remaining <= 0 && forecast.nextResetAtMs !== lastRolledOverResetAt && isBackendReady() && !isBusy) {
    lastRolledOverResetAt = forecast.nextResetAtMs;
    void refreshSnapshot();
  }
}, 1000);

setInterval(() => {
  if (autoRefresh && isBackendReady() && !isBusy) {
    void refreshSnapshot();
  }
}, 15_000);

async function bootstrap(): Promise<void> {
  // Fast-path: Sidecar Web UI serves over http(s) on localhost with /api/snapshot
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    try {
      const res = await fetch('/api/snapshot');
      if (res.ok) {
        const data = (await res.json()) as UsageSnapshot;
        if (data && Array.isArray(data.pools)) {
          transportMode = 'sidecar';
          snapshot = data;
          selectedPoolId = data.primaryPoolId;
          statusNotice = '';
          render();
          return;
        }
      }
    } catch {
      // Fall through to MCP App postMessage handshake
    }
  }

  try {
    await app.connect();
    transportMode = 'mcp';
    const caps = app.getHostCapabilities();
    canSendMessage = Boolean(caps && (caps as Record<string, unknown>).message);
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (!snapshot) {
      await refreshSnapshot();
    }
  } catch {
    statusNotice = '未检测到 Antigravity 宿主环境（请在 Antigravity 插件或 Sidecar 中打开）。';
    render();
  }
}

void bootstrap();
