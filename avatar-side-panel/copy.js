/**
 * Panel copy from the revised approved design.
 *
 * Cap numbers, pack sizes and prices are drawn as TBD chips until pricing
 * plans set them — this file does not hard-code prices or caps in the
 * buy-credits flow. Only admins can buy credits; everyone else gets
 * "Contact your A-Gent admin".
 */

import { allowedSitesSummary } from './allowed-sites.js';

export function tbd(label) {
  return { kind: 'tbd', label: `${label} · TBD` };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * @param {string} state
 * @param {{ isAdmin?: boolean, siteHost?: string, durationSeconds?: number, retryAfter?: number, turnCount?: number }} [opts]
 */
export function stateCopy(state, {
  isAdmin = false,
  siteHost = '',
  durationSeconds = 0,
  retryAfter = 0,
  turnCount = 0,
} = {}) {
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
        message: 'Connecting to Katya… Starting a secure live session.',
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
        message: `Session ended · ${formatDuration(durationSeconds)}. Thanks. The transcript and your draft stay here.`,
        action: 'Start again', copyTranscript: true, announce: 'status',
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
          : 'The avatar is busy or you started several sessions quickly. Wait a minute, then try again.',
        action: retryAfter ? `Try again in ${retryAfter}s` : 'Try again in a minute',
        announce: 'alert',
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
    case 'monthly-cap':
      if (!isAdmin) {
        return {
          pill: 'Paused', pillKind: 'off',
          title: 'Only admins can buy credits',
          kind: 'Monthly limit',
          message: 'Your workspace used all ',
          chips: [tbd('monthly minutes')],
          messageAfter: ' live minutes. Ask your A-Gent admin to add credits, or wait until ',
          chipsAfter: [tbd('reset date')],
          messageEnd: '.',
          action: 'Contact your A-Gent admin',
          contactAdmin: true, buyMore: false, announce: 'alert',
        };
      }
      return {
        pill: 'Paused', pillKind: 'off',
        title: "This month's live minutes are used up",
        kind: 'Monthly limit',
        message: 'Your workspace used all ',
        chips: [tbd('monthly minutes')],
        messageAfter: ' live minutes. Live video comes back on ',
        chipsAfter: [tbd('reset date')],
        messageEnd: ', or buy more credits now.',
        action: 'Buy more credits',
        secondaryAction: 'Contact your A-Gent admin',
        contactAdmin: true, buyMore: true, announce: 'alert',
      };
    case 'session-timeout':
      return {
        pill: 'Session ended', pillKind: 'off',
        title: 'Session reached its time limit',
        kind: 'Per-session limit',
        message: 'Each live session runs up to ',
        chips: [tbd('session length')],
        messageAfter: '. Your draft, notes and transcript are kept. You have ',
        chipsAfter: [tbd('minutes left')],
        messageEnd: ' this month.',
        action: 'Start new session',
        secondaryAction: isAdmin ? 'Buy more credits' : 'Contact your A-Gent admin',
        buyMore: isAdmin, contactAdmin: !isAdmin, copyTranscript: true, announce: 'status',
      };
    case 'choose-credits':
      return {
        pill: 'Buy credits', pillKind: 'busy',
        title: 'Choose credits',
        message: 'Credits add live avatar minutes for your workspace. Checkout opens on A-Gent billing in a new tab. This panel never asks for card details.',
        action: 'Continue to checkout (preview)',
        secondaryAction: 'Cancel',
        packs: [
          { id: 'pack-1', name: 'Pack 1' },
          { id: 'pack-2', name: 'Pack 2' },
          { id: 'pack-3', name: 'Pack 3' },
        ],
        announce: 'status',
      };
    case 'checkout-wait':
      return {
        pill: 'Waiting for checkout', pillKind: 'busy',
        title: 'Waiting for checkout',
        message: 'Checkout is not available in this pilot. This panel never asks for card details, and your credits have not changed.',
        action: 'Open checkout again (preview)',
        secondaryAction: 'Cancel purchase',
        announce: 'status',
      };
    case 'credits-added':
      return {
        pill: 'Credits added', pillKind: 'live',
        title: 'Credits added to your workspace',
        message: 'Credits added to your workspace. New balance: ',
        chips: [tbd('minutes')],
        messageEnd: ' live minutes this month.',
        action: 'Start conversation', announce: 'status',
      };
    case 'purchase-failed':
      return {
        pill: 'Purchase not completed', pillKind: 'bad',
        title: 'Purchase not completed',
        message: "Checkout was closed or the payment didn't go through. Your credits haven't changed.",
        action: 'Try again',
        secondaryAction: 'Contact your A-Gent admin',
        contactAdmin: true, announce: 'alert',
      };
    case 'mic-needed':
      return {
        pill: 'Microphone', pillKind: 'off',
        title: 'Allow the microphone',
        message: 'Chrome may not show a microphone prompt in the side panel. A tab just opened so you can allow it for this extension. After you allow it, come back here and start again. This does not start a paid session.',
        action: 'Allow microphone',
        secondaryAction: 'Cancel',
        announce: 'status',
      };
    case 'contact-admin':
      return {
        pill: 'Paused', pillKind: 'off',
        title: 'Contact your A-Gent admin',
        message: 'Only admins can buy credits. Ask your A-Gent admin to add credits for this workspace. This panel does not invent an admin address, and it will not open a message until a tenant admin list is available.',
        action: 'Got it', announce: 'status',
      };
    default:
      return { pill: 'Not started', pillKind: 'off', message: '', action: 'Start conversation', announce: null };
  }
}
