/**
 * Panel copy from the approved design. Cap numbers and reset dates come from
 * the server when available — this file does not hard-code prices or caps
 * in the "Buy more credits" flow.
 */

import { allowedSitesSummary } from './allowed-sites.js';

export const ASK_OWNER = 'your workspace owner';

function fmtReset(iso) {
  if (!iso) return 'the next reset date';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return 'the next reset date';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch {
    return 'the next reset date';
  }
}

function fmtMinutes(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'its';
  const v = Number(n);
  return String(Math.round(v) === v ? v : Math.round(v * 10) / 10);
}

function fmtSessionMax(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'its time limit';
  const s = Number(seconds);
  if (s % 60 === 0) {
    const m = s / 60;
    return m === 1 ? '1 minute' : `${m} minutes`;
  }
  return s === 1 ? '1 second' : `${s} seconds`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Copy and chrome for each panel state. `caps` is optional server status. */
export function stateCopy(state, { caps = {}, siteHost = '', durationSeconds = 0, retryAfter = 0 } = {}) {
  const reset = fmtReset(caps.reset_at);
  const capMin = fmtMinutes(caps.monthly_minute_cap);
  const sessionMax = fmtSessionMax(caps.max_session_seconds);
  const places = allowedSitesSummary();

  switch (state) {
    case 'idle':
      return {
        pill: 'Not started', pillKind: 'off',
        message: 'Start a live conversation, or open an email for help with a reply.',
        action: 'Start conversation', announce: null,
      };
    case 'connecting':
      return {
        pill: 'Connecting…', pillKind: 'busy',
        message: 'Connecting to Katya… Starting a secure live session. Usually under 5 seconds.',
        action: 'Cancel', announce: 'status',
      };
    case 'live':
      return {
        pill: 'Live · Listening', pillKind: 'live',
        message: 'Ask about the open email, or say "draft a reply".',
        action: null, announce: 'status',
      };
    case 'speaking':
      return {
        pill: 'Live · Speaking', pillKind: 'live',
        message: '', action: null, announce: 'log',
      };
    case 'thinking':
      return {
        pill: 'Thinking…', pillKind: 'busy',
        message: 'Thinking…', action: null, announce: 'status',
      };
    case 'ended':
      return {
        pill: 'Session ended', pillKind: 'off',
        message: `Session ended · ${formatDuration(durationSeconds)}. Thanks. Your draft and notes stay below until you close the panel.`,
        action: 'Start again', announce: 'status',
      };
    case 'couldnt-start':
      return {
        pill: "Couldn't start", pillKind: 'bad',
        title: "Couldn't start",
        message: 'Something went wrong on our side or with your connection. Check your connection, then try again.',
        action: 'Try again', announce: 'alert',
      };
    case 'cooldown':
    case 'too-many-starts':
      return {
        pill: "Couldn't start", pillKind: 'bad',
        title: "Couldn't start",
        message: retryAfter
          ? `The avatar is busy or you started several sessions quickly. Wait ${retryAfter} second${retryAfter === 1 ? '' : 's'}, then try again.`
          : 'The avatar is busy or you started several sessions quickly. Wait a moment, then try again.',
        action: retryAfter ? `Try again in ${retryAfter}s` : 'Try again',
        announce: 'alert',
      };
    case 'monthly-cap':
      return {
        pill: 'Paused', pillKind: 'off',
        title: "This month's live minutes are used up",
        kind: 'Monthly limit',
        message: caps.monthly_minute_cap != null
          ? `Your workspace used all ${capMin} live minutes. Live video comes back on ${reset}. To raise the limit, ask ${ASK_OWNER}.`
          : `This month's live minutes are used up. Live video comes back on ${reset}. To raise the limit, ask ${ASK_OWNER}.`,
        action: null, disabledReason: 'Monthly limit reached',
        buyMore: true, announce: 'alert',
      };
    case 'session-timeout':
      return {
        pill: 'Session ended', pillKind: 'off',
        title: 'Session reached its time limit',
        kind: 'Per-session limit',
        message: `Each live session runs up to ${sessionMax}. Your draft and notes are kept. You still have minutes this month.`,
        action: 'Start new session',
        buyMore: true, announce: 'status',
      };
    case 'fail-closed':
      return {
        pill: 'Unavailable', pillKind: 'bad',
        title: 'Avatar unavailable right now',
        message: "We couldn't check your usage, so we didn't start a session. Nothing was billed. Try again in a few minutes.",
        action: 'Check again', announce: 'alert',
      };
    case 'not-allowed':
      return {
        pill: 'Off on this site', pillKind: 'off',
        title: 'A-Gent is off on this site',
        message: `It works in ${places}. It doesn't read or record this page.`,
        host: siteHost, action: null, announce: 'status',
      };
    case 'buy-credits':
      return {
        pill: null, pillKind: null,
        title: 'Buy more credits',
        message: 'Credit purchases are not available in this pilot. Ask your workspace owner if you need a higher limit.',
        action: 'Got it', announce: 'status',
      };
    default:
      return { pill: 'Not started', pillKind: 'off', message: '', action: 'Start conversation', announce: null };
  }
}
