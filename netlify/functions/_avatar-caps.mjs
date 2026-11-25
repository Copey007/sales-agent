/**
 * Platform-wide LiveAvatar caps for the A-Gent pilot.
 *
 * Defaults are conservative relative to LiveAvatar Starter (historically
 * 200 credits / month, ~100 FULL-mode minutes, 5-minute session max; 2
 * credits per FULL minute). The credits API returns remaining balance
 * only, not the plan allowance, so these stay well below that historical
 * ceiling. Override with env vars; never raise defaults without checking
 * the live allowance. Overage must stay off — these caps are our backstop.
 *
 * Env (all optional, positive integers):
 *   AVATAR_MONTHLY_MINUTE_CAP          default 60   (FULL-mode minutes)
 *   AVATAR_MAX_SESSION_SECONDS         default 180  (3 minutes)
 *   AVATAR_HEARTBEAT_TIMEOUT_SECONDS   default 60
 *
 * Values are floored first, then rejected if <= 0, then clamped to the
 * maxima below so a typo like 1e9 cannot disable the backstop.
 */
export const DEFAULT_MONTHLY_MINUTE_CAP = 60;
export const DEFAULT_MAX_SESSION_SECONDS = 180;
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 60;
export const MAX_MONTHLY_MINUTE_CAP = 10_000;
export const MAX_MAX_SESSION_SECONDS = 3600;
export const MAX_HEARTBEAT_TIMEOUT_SECONDS = 600;

function envInt(name, fallback, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored <= 0) return fallback;
  if (max != null && floored > max) return max;
  return floored;
}

function clampInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored <= 0) return fallback;
  if (max != null && floored > max) return max;
  return floored;
}

/**
 * Effective caps for a token/reaper/heartbeat decision.
 * The platform env cap always wins when the agent's own monthly cap is higher
 * or unset, so a 500- or 2000-minute agent row cannot exceed Starter.
 */
export function getAvatarCaps(agent = {}) {
  const platformMonthly = envInt('AVATAR_MONTHLY_MINUTE_CAP', DEFAULT_MONTHLY_MINUTE_CAP, MAX_MONTHLY_MINUTE_CAP);
  const agentMonthly = clampInt(agent.monthly_minute_cap, platformMonthly, MAX_MONTHLY_MINUTE_CAP);
  return {
    monthlyMinuteCap: Math.min(platformMonthly, agentMonthly),
    maxSessionSeconds: envInt('AVATAR_MAX_SESSION_SECONDS', DEFAULT_MAX_SESSION_SECONDS, MAX_MAX_SESSION_SECONDS),
    heartbeatTimeoutSeconds: envInt('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, MAX_HEARTBEAT_TIMEOUT_SECONDS),
  };
}

export function sessionOverMax({ startedAt, durationSeconds, maxSessionSeconds }) {
  const max = maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS;
  const recorded = Number(durationSeconds) || 0;
  if (recorded >= max) return true;
  if (startedAt) {
    const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= max) return true;
  }
  return false;
}

/**
 * Billable duration: wall time since started_at, at least any client-reported
 * value (so under-reporting cannot shrink usage), capped at the per-session max.
 */
export function serverDurationSeconds(row, clientDuration, maxSessionSeconds) {
  const max = maxSessionSeconds ?? DEFAULT_MAX_SESSION_SECONDS;
  const startedAt = row?.started_at;
  const elapsed = startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : 0;
  const server = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  const client = Number(clientDuration);
  const clientVal = Number.isFinite(client) && client > 0 ? client : 0;
  return Math.max(0, Math.round(Math.min(max, Math.max(server, clientVal))));
}
