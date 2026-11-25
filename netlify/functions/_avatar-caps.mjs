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
 *   AVATAR_COOLDOWN_SECONDS            default 30   (gap after a session ends)
 *   AVATAR_BILLING_RESET_DAY           default 26   (UTC day the monthly window resets)
 *
 * Values are floored first, then rejected if <= 0, then clamped to the
 * maxima below so a typo like 1e9 cannot disable the backstop.
 * The 60-minute and 180-second defaults are unchanged.
 */
export const DEFAULT_MONTHLY_MINUTE_CAP = 60;
export const DEFAULT_MAX_SESSION_SECONDS = 180;
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 60;
export const DEFAULT_COOLDOWN_SECONDS = 30;
export const DEFAULT_BILLING_RESET_DAY = 26;
export const MAX_MONTHLY_MINUTE_CAP = 10_000;
export const MAX_MAX_SESSION_SECONDS = 3600;
export const MAX_HEARTBEAT_TIMEOUT_SECONDS = 600;
export const MAX_COOLDOWN_SECONDS = 600;
export const MAX_BILLING_RESET_DAY = 28;

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
  const resetDay = envInt('AVATAR_BILLING_RESET_DAY', DEFAULT_BILLING_RESET_DAY, MAX_BILLING_RESET_DAY);
  return {
    monthlyMinuteCap: Math.min(platformMonthly, agentMonthly),
    maxSessionSeconds: envInt('AVATAR_MAX_SESSION_SECONDS', DEFAULT_MAX_SESSION_SECONDS, MAX_MAX_SESSION_SECONDS),
    heartbeatTimeoutSeconds: envInt('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, MAX_HEARTBEAT_TIMEOUT_SECONDS),
    cooldownSeconds: envInt('AVATAR_COOLDOWN_SECONDS', DEFAULT_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS),
    billingResetDay: resetDay,
  };
}

/**
 * Monthly usage window that resets at 00:00 UTC on `resetDay` (default the 26th),
 * not on the 1st of the calendar month. If today is the 26th or later, the
 * window started this month; otherwise it started last month.
 */
export function billingWindow(now = new Date(), resetDay = DEFAULT_BILLING_RESET_DAY) {
  const day = Number.isFinite(Number(resetDay)) ? Math.floor(Number(resetDay)) : DEFAULT_BILLING_RESET_DAY;
  const safeDay = day >= 1 && day <= MAX_BILLING_RESET_DAY ? day : DEFAULT_BILLING_RESET_DAY;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const start = d >= safeDay
    ? new Date(Date.UTC(y, m, safeDay, 0, 0, 0))
    : new Date(Date.UTC(y, m - 1, safeDay, 0, 0, 0));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, safeDay, 0, 0, 0));
  return { start, end, resetAt: end, resetDay: safeDay };
}

/** ISO-8601 UTC timestamp of the current window start, second precision. */
export function billingWindowStartIso(now = new Date(), resetDay = DEFAULT_BILLING_RESET_DAY) {
  return billingWindow(now, resetDay).start.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
