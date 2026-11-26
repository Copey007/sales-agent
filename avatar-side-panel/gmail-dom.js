/**
 * ESM facade over gmail-dom-classic.js for tests, the module service worker,
 * and other ESM panel files. This file is not listed in content_scripts.
 */
import './gmail-dom-classic.js';

const api = globalThis.__AGENT_GMAIL_DOM__;

export const GMAIL_SELECTORS = api.GMAIL_SELECTORS;
export const EMAIL_EXCERPT_MAX = api.EMAIL_EXCERPT_MAX;
export const DRAFT_MAX_CHARS = api.DRAFT_MAX_CHARS;
export const AGENT_DRAFT_ATTR = api.AGENT_DRAFT_ATTR;
export const firstMatch = api.firstMatch;
export const allMatches = api.allMatches;
export const findComposeBox = api.findComposeBox;
export const findSignature = api.findSignature;
export const findQuote = api.findQuote;
export const sanitizeDraftText = api.sanitizeDraftText;
export const readThread = api.readThread;
export const insertDraft = api.insertDraft;
export const openCompose = api.openCompose;
export const insertDraftIntoGmail = api.insertDraftIntoGmail;
export const isGmailUrl = api.isGmailUrl;
