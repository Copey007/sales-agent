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
 */
export const DEFAULT_MONTHLY_MINUTE_CAP = 60;
export const DEFAULT_MAX_SESSION_SECONDS = 180;
export const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 60;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Effective caps for a token/reaper/heartbeat decision.
 * The platform env cap always wins when the agent's own monthly cap is higher
 * or unset, so a 500- or 2000-minute agent row cannot exceed Starter.
 */
export function getAvatarCaps(agent = {}) {
  const platformMonthly = envInt('AVATAR_MONTHLY_MINUTE_CAP', DEFAULT_MONTHLY_MINUTE_CAP);
  const agentCap = Number(agent.monthly_minute_cap);
  const agentMonthly = Number.isFinite(agentCap) && agentCap > 0 ? Math.floor(agentCap) : platformMonthly;
  return {
    monthlyMinuteCap: Math.min(platformMonthly, agentMonthly),
    maxSessionSeconds: envInt('AVATAR_MAX_SESSION_SECONDS', DEFAULT_MAX_SESSION_SECONDS),
    heartbeatTimeoutSeconds: envInt('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', DEFAULT_HEARTBEAT_TIMEOUT_SECONDS),
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
