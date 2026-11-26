/**
 * Classic (non-module) Gmail DOM helpers. Loaded as a content script in the
 * isolated world on https://mail.google.com/* only. No import/export — MV3
 * content scripts are classic scripts, and "type": "module" is ignored.
 *
 * Attaches a namespaced API to the content-script global, which is not the
 * Gmail page's window. Tests and the module service worker import the ESM
 * shim in gmail-dom.js, which side-effect-loads this file.
 */
(function (global) {
  'use strict';

/**
 * Gmail tab-only DOM helpers for week-3 draft insertion.
 *
 * Approach (documented for the PR):
 * - Read and write only through the open mail.google.com tab. There is no
 *   Gmail API, no background Gmail send scope, and no
 *   content script outside https://mail.google.com/*.
 * - Prefer stable ARIA / data attributes over Gmail's short CSS classes,
 *   then fall back to the long-lived class names used in the test fixtures.
 * - The compose body is a contenteditable textbox (`aria-label="Message Body"`
 *   or `g_editable="true"`). The person's signature lives in
 *   `.gmail_signature` / `[data-smartmail="gmail_signature"]` inside that box.
 * - Insert the draft as text nodes (never innerHTML) immediately before the
 *   signature, or before the quoted reply if no signature is found. Never
 *   replace, empty, or overwrite a signature. Never invent an A-Gent signature.
 * - Opening compose clicks Reply (preferred) or Compose. It never clicks Send.
 * - Selectors are locked by tests/fixtures/gmail/*.html. A Gmail UI change
 *   that drops these hooks fails the suite instead of silently no-oping
 *   (or, worse, sending).
 */

const GMAIL_SELECTORS = {
  composeEditable: [
    'div[aria-label="Message Body"][contenteditable="true"]',
    'div[aria-label="Message body"][contenteditable="true"]',
    'div[g_editable="true"][role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"][g_editable="true"]',
  ],
  signature: [
    '[data-smartmail="gmail_signature"]',
    'div.gmail_signature',
  ],
  quote: [
    'div.gmail_quote',
    'blockquote.gmail_quote',
  ],
  composeButton: [
    'div[role="button"][gh="cm"]',
    'div[role="button"][aria-label="Compose"]',
    'div[role="button"][aria-label^="Compose"]',
    'button[aria-label="Compose"]',
  ],
  replyButton: [
    'div[role="button"][aria-label="Reply"]',
    'div[role="button"][aria-label^="Reply"]',
    'span[role="link"][aria-label="Reply"]',
    'button[aria-label="Reply"]',
    '[data-tooltip="Reply"]',
  ],
  // Intentionally listed so tests can prove we never click them.
  sendButton: [
    'div[role="button"][aria-label="Send"]',
    'div[role="button"][aria-label^="Send"]',
    'button[aria-label="Send"]',
    '[data-tooltip="Send"]',
    'div[role="button"][aria-label="Send ‪(Ctrl-Enter)‬"]',
  ],
  threadMessage: [
    'div[data-message-id] div.a3s',
    'div.a3s.aiL',
  ],
  subject: [
    'h2[data-thread-perm-id]',
    'h2.hP',
  ],
  sender: [
    'span.gD[email]',
    'h3 span[email]',
  ],
};

const EMAIL_EXCERPT_MAX = 1200;
const DRAFT_MAX_CHARS = 10_000;
const AGENT_DRAFT_ATTR = 'data-agent-draft';

function firstMatch(root, selectors) {
  if (!root || typeof root.querySelector !== 'function') return null;
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function allMatches(root, selectors) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) {
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
  }
  return out;
}

function findComposeBox(doc) {
  const boxes = allMatches(doc, GMAIL_SELECTORS.composeEditable);
  return boxes[boxes.length - 1] || null;
}

function findSignature(composeEl) {
  if (!composeEl) return null;
  return firstMatch(composeEl, GMAIL_SELECTORS.signature);
}

function findQuote(composeEl) {
  if (!composeEl) return null;
  return firstMatch(composeEl, GMAIL_SELECTORS.quote);
}

/**
 * Strip tags and cap length. Drafts are always inserted as text, never HTML.
 */
function sanitizeDraftText(text) {
  let s = String(text ?? '');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/\u0000/g, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.trim();
  if (s.length > DRAFT_MAX_CHARS) s = s.slice(0, DRAFT_MAX_CHARS).trim();
  return s;
}

function visibleText(el) {
  if (!el) return '';
  const text = (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
  return text;
}

function readThread(doc) {
  const subjectEl = firstMatch(doc, GMAIL_SELECTORS.subject);
  const senderEl = firstMatch(doc, GMAIL_SELECTORS.sender);
  const messages = allMatches(doc, GMAIL_SELECTORS.threadMessage);
  const last = messages[messages.length - 1] || null;
  let bodyText = '';
  if (last) {
    const clone = last.cloneNode(true);
    for (const q of allMatches(clone, GMAIL_SELECTORS.quote)) q.remove();
    for (const sig of allMatches(clone, GMAIL_SELECTORS.signature)) sig.remove();
    bodyText = visibleText(clone);
  }
  if (bodyText.length > EMAIL_EXCERPT_MAX) {
    bodyText = `${bodyText.slice(0, EMAIL_EXCERPT_MAX).trim()}…`;
  }
  const fromName = senderEl ? (senderEl.textContent || '').trim() : '';
  const fromEmail = senderEl?.getAttribute?.('email') || '';
  const from = [fromName, fromEmail && fromEmail !== fromName ? `<${fromEmail}>` : '']
    .filter(Boolean)
    .join(' ')
    .trim();
  const compose = findComposeBox(doc);
  return {
    subject: subjectEl ? visibleText(subjectEl) : '',
    from,
    fromEmail,
    bodyText,
    hasCompose: Boolean(compose),
    hasSignature: Boolean(compose && findSignature(compose)),
  };
}

function appendPlainText(doc, parent, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    if (i) parent.appendChild(doc.createElement('br'));
    if (line) parent.appendChild(doc.createTextNode(line));
  });
}

/**
 * Insert plain-text draft into the open compose box, leaving any signature
 * (and quoted thread) untouched. Re-inserting replaces only our previous
 * [data-agent-draft] node.
 */
function insertDraft(doc, text) {
  const body = sanitizeDraftText(text);
  if (!body) return { ok: false, error: 'empty_draft' };
  const compose = findComposeBox(doc);
  if (!compose) return { ok: false, error: 'compose_missing' };

  const signature = findSignature(compose);
  const signatureHtmlBefore = signature ? signature.outerHTML : null;
  const signatureTextBefore = signature ? visibleText(signature) : '';

  const existing = compose.querySelector(`[${AGENT_DRAFT_ATTR}]`);
  const block = doc.createElement('div');
  block.setAttribute(AGENT_DRAFT_ATTR, 'true');
  appendPlainText(doc, block, body);

  if (existing) {
    existing.replaceWith(block);
  } else {
    const anchor = signature || findQuote(compose);
    if (anchor) compose.insertBefore(block, anchor);
    else compose.appendChild(block);
  }

  const signatureAfter = findSignature(compose);
  if (signatureHtmlBefore) {
    if (!signatureAfter || signatureAfter.outerHTML !== signatureHtmlBefore) {
      return { ok: false, error: 'signature_clobbered' };
    }
  }
  return {
    ok: true,
    signaturePreserved: !signatureTextBefore || visibleText(findSignature(compose)) === signatureTextBefore,
    hasSignature: Boolean(findSignature(compose)),
  };
}

function isSendControl(el) {
  if (!el) return true;
  const label = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-tooltip') || ''} ${el.textContent || ''}`;
  return /^\s*send\b/i.test(label.trim()) || /\bsend\b/i.test((el.getAttribute?.('aria-label') || '').trim());
}

/**
 * Click Reply (preferred) or Compose. Never clicks a Send control.
 */
async function openCompose(doc, { timeoutMs = 800, intervalMs = 20, click } = {}) {
  if (findComposeBox(doc)) return { ok: true, alreadyOpen: true };
  const reply = firstMatch(doc, GMAIL_SELECTORS.replyButton);
  const composeBtn = firstMatch(doc, GMAIL_SELECTORS.composeButton);
  const btn = reply || composeBtn;
  if (!btn) return { ok: false, error: 'compose_unavailable' };
  if (isSendControl(btn)) return { ok: false, error: 'compose_unavailable' };
  const doClick = typeof click === 'function' ? click : (el) => el.click();
  doClick(btn);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findComposeBox(doc)) return { ok: true, alreadyOpen: false };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: 'compose_unavailable' };
}

async function insertDraftIntoGmail(doc, text, openOpts) {
  const first = insertDraft(doc, text);
  if (first.ok || first.error === 'empty_draft' || first.error === 'signature_clobbered') {
    return first;
  }
  const opened = await openCompose(doc, openOpts);
  if (!opened.ok) return { ok: false, error: 'compose_unavailable' };
  return insertDraft(doc, text);
}

function isGmailUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'mail.google.com';
  } catch {
    return false;
  }
}

  global.__AGENT_GMAIL_DOM__ = {
    GMAIL_SELECTORS: GMAIL_SELECTORS,
    EMAIL_EXCERPT_MAX: EMAIL_EXCERPT_MAX,
    DRAFT_MAX_CHARS: DRAFT_MAX_CHARS,
    AGENT_DRAFT_ATTR: AGENT_DRAFT_ATTR,
    firstMatch: firstMatch,
    allMatches: allMatches,
    findComposeBox: findComposeBox,
    findSignature: findSignature,
    findQuote: findQuote,
    sanitizeDraftText: sanitizeDraftText,
    readThread: readThread,
    insertDraft: insertDraft,
    openCompose: openCompose,
    insertDraftIntoGmail: insertDraftIntoGmail,
    isGmailUrl: isGmailUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
