/**
 * Shared Hunter.io verification policy for prospect enrollment.
 *
 * Default (HUNTER_ALLOW_RISKY unset or false):
 *   Accept:  `valid`, and `webmail` with score > 50
 *   Reject:  `accept_all` (catch-all), `unknown`, `disposable`,
 *            `invalid`, and any other status
 *
 * Set HUNTER_ALLOW_RISKY=true to also accept `accept_all`, which was
 * the previous default on researcher-background and campaign-orchestrator.
 * `unknown` and `disposable` stay rejected either way.
 *
 * High-confidence domain-search hits (>= 90) that carry no verification
 * status still skip the verifier (quota). If domain-search already
 * includes a verification.status, this policy applies to them too.
 */

function readEnv(key, fallback = '') {
  if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
    return Netlify.env.get(key) || process.env[key] || fallback;
  }
  return process.env[key] || fallback;
}

export const RISKY_HUNTER_STATUSES = ['accept_all', 'unknown', 'disposable'];

export function hunterAllowRisky() {
  const raw = String(readEnv('HUNTER_ALLOW_RISKY') || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * @param {string|null|undefined} status Hunter verifier / verification status
 * @param {number} [score=0]
 * @param {{ allowRisky?: boolean }} [opts]
 */
export function hunterResultAcceptable(status, score = 0, opts = {}) {
  const s = String(status || '').toLowerCase();
  const riskyOk = opts.allowRisky ?? hunterAllowRisky();
  if (s === 'valid') return true;
  if (s === 'webmail' && Number(score) > 50) return true;
  if (riskyOk && s === 'accept_all') return true;
  return false;
}
