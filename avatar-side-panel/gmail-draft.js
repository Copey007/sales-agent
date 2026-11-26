/**
 * Week-3 Gmail draft helpers used by the side panel.
 * No send path lives here: we only build a prompt, keep a draft string, and
 * render Insert / Copy actions. Gmail's Send button remains the only send.
 */

import { EMAIL_EXCERPT_MAX, sanitizeDraftText } from './gmail-dom.js';

export const GMAIL_COPY = {
  title: 'Gmail draft',
  helper: 'You click Send in Gmail. A-Gent never sends email.',
  insert: 'Insert draft',
  copyDraft: 'Copy draft',
  propose: 'Propose a reply',
  read: 'Read this email',
  inserted: 'Draft inserted into Gmail. You click Send in Gmail.',
  composeMissing: "Gmail compose isn't open, and we couldn't open it. Your draft is still here to copy.",
  insertFailed: "We couldn't insert the draft. It's still here to copy.",
  needSession: 'Start a conversation to have A-Gent propose a reply.',
  noThread: 'Open a Gmail thread to read the message and propose a reply.',
  reading: 'Reading the open email…',
};

export function isDraftRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\b(draft|propose|write|compose)\b[\s\S]{0,40}\b(reply|email|response)\b/i.test(t)
    || /\b(reply|email)\b[\s\S]{0,40}\b(draft|propose)\b/i.test(t)
    || /\bdraft a reply\b/i.test(t)
    || /\bwrite (me )?an? (reply|email)\b/i.test(t);
}

export function shortDraftCaption(thread) {
  const subject = thread?.subject ? ` to “${thread.subject}”` : '';
  return `Draft a reply${subject}`;
}

export function buildDraftPrompt(thread, userText = '') {
  const excerpt = String(thread?.bodyText || '').slice(0, EMAIL_EXCERPT_MAX);
  const extra = String(userText || '').trim();
  const lines = [
    'The person is looking at this Gmail thread in their browser.',
    'Propose a reply they can insert into Gmail as a draft. They will click Send in Gmail themselves.',
    'Write only the email body. Do not include a subject line, a signature, or a name placeholder. Gmail will add their existing signature. Do not offer to send the email.',
  ];
  if (thread?.subject) lines.push(`Subject: ${thread.subject}`);
  if (thread?.from) lines.push(`From: ${thread.from}`);
  lines.push(excerpt ? `Message:\n${excerpt}` : 'The message body could not be read.');
  if (extra && !/^\s*(draft|propose|write)(\s+a)?\s+(reply|email)\s*$/i.test(extra)) {
    lines.push(`The person added: ${extra}`);
  }
  return lines.join('\n\n');
}

/**
 * Keep the email body only: drop a leading Subject line the model might add,
 * and drop a trailing invented signature (a `--` / em-dash divider).
 */
export function extractDraftBody(reply) {
  let s = sanitizeDraftText(reply);
  s = s.replace(/^subject\s*:\s*.+\n+/i, '');
  const sigSplit = s.split(/\n(?:--+|—|–)\s*\n/);
  if (sigSplit.length > 1) s = sigSplit[0].trim();
  return s;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Markup for the Gmail draft card. `icon` is a function(name) => html.
 * Never includes a control whose accessible name is only the word Send.
 */
export function gmailDraftCardHtml({
  enabled = true,
  isGmail = false,
  thread = null,
  draft = '',
  insertStatus = null,
  sessionLive = false,
  icon = () => '',
} = {}) {
  if (!enabled) return '';
  if (!isGmail && !draft) return '';

  const parts = [];
  parts.push('<div class="card" id="gmail-card">');
  parts.push(`<div class="ch">${icon('mail')}<div class="t"><b>${esc(GMAIL_COPY.title)}</b>`);
  if (thread?.subject) {
    parts.push(`<span>${esc(thread.subject)}${thread.from ? ` · ${esc(thread.from)}` : ''}</span>`);
  } else if (!isGmail) {
    parts.push(`<span>${esc(GMAIL_COPY.noThread)}</span>`);
  } else {
    parts.push(`<span>${esc(GMAIL_COPY.noThread)}</span>`);
  }
  parts.push('</div></div>');

  if (thread?.bodyText) {
    const snippet = thread.bodyText.length > 280 ? `${thread.bodyText.slice(0, 280).trim()}…` : thread.bodyText;
    parts.push(`<div class="body" id="gmail-thread-snippet">${esc(snippet)}</div>`);
  }

  if (draft) {
    parts.push(`<div class="draft" id="gmail-draft-text">${esc(draft)}</div>`);
  }

  if (insertStatus === 'inserted') {
    parts.push(`<div class="read" role="status">${icon('check')}<span>${esc(GMAIL_COPY.inserted)}</span></div>`);
  } else if (insertStatus === 'compose_missing') {
    parts.push(`<div class="card notice" role="status" id="gmail-compose-missing"><div class="body">${esc(GMAIL_COPY.composeMissing)}</div></div>`);
  } else if (insertStatus === 'error') {
    parts.push(`<div class="err-t" role="status">${esc(GMAIL_COPY.insertFailed)}</div>`);
  }

  const buttons = [];
  if (isGmail) {
    buttons.push(`<button class="btn sec" id="gmail-read-btn" type="button">${icon('mail')}${esc(GMAIL_COPY.read)}</button>`);
  }
  if (isGmail && sessionLive) {
    buttons.push(`<button class="btn sec" id="gmail-propose-btn" type="button">${icon('note')}${esc(GMAIL_COPY.propose)}</button>`);
  } else if (isGmail && !draft) {
    parts.push(`<div class="help">${icon('info')}<span>${esc(GMAIL_COPY.needSession)}</span></div>`);
  }
  if (draft) {
    if (isGmail) {
      buttons.push(`<button class="btn accent" id="gmail-insert-btn" type="button">${icon('insert')}${esc(GMAIL_COPY.insert)}</button>`);
    }
    buttons.push(`<button class="btn sec" id="gmail-copy-btn" type="button">${icon('copy')}${esc(GMAIL_COPY.copyDraft)}</button>`);
  }
  if (buttons.length) parts.push(`<div class="row" id="gmail-actions">${buttons.join('')}</div>`);
  parts.push(`<div class="help">${icon('info')}<span>${esc(GMAIL_COPY.helper)}</span></div>`);
  parts.push('</div>');
  return parts.join('');
}
