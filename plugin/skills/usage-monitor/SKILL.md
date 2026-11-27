---
name: usage-monitor
description: >-
  Monitor Google Antigravity quota consumption, forecast remaining quota percentage
  at next refresh (5h rolling and 7d weekly windows), analyze total/cache/output tokens,
  and calibrate quota anchors from /usage. Use when the user asks about token usage,
  remaining quota, burn rate, or refresh forecasts.
---

# Antigravity Usage Monitor Skill

Use the `antigravity-usage-monitor` MCP server tools whenever the user asks about:
- Current remaining quota & **predicted remaining percentage at next refresh** (下次刷新时余下百分比)
- Total tokens consumed (Fresh Input, Prompt Cache Read, Output, Cache Hit Rate)
- Per-model or per-conversation token breakdowns
- Calibrating quota from Antigravity's native `/usage` or **Settings -> Models**

## Workflows

1. **Open Interactive Dashboard**:
   - Call `open_usage_monitor` to open the interactive MCP App dashboard in the Antigravity side pane (`aux_pane`) or global sidebar (`global`).
   - Or call `get_usage_summary` for a quick inline summary card plus text report.

2. **Calibrate Accuracy Against `/usage`**:
   - When the user shares their exact remaining percentage and reset countdown from `/usage` (e.g., "Gemini Pro 还剩 68%，2小时10分后刷新"), call `calibrate_quota` with `poolId`, `remainingPct`, and `resetInMinutes`.
   - Remind the user that calibrating twice within the same refresh window automatically learns their exact `weightedTokensPerPercent` multiplier.

3. **Deep-Dive Token Optimization**:
   - Call `get_conversation_breakdown` to inspect which conversations consume the most tokens and evaluate Prompt Cache hit rates.
   - If the forecast predicts exhaustion before next refresh, highlight the `safeBurnRatePctPerHour` budget and suggest switching lightweight tasks to Gemini Flash.
