/**
 * Content script for https://mail.google.com/* only.
 *
 * Tab-only access: read the visible thread and insert a draft into the open
 * compose box (opening Reply/Compose if needed). It never clicks Send, never
 * calls a Gmail API, and never runs on any other host.
 */
import {
  readThread,
  insertDraftIntoGmail,
  isGmailUrl,
} from './gmail-dom.js';

function onGmail() {
  const href = globalThis.location?.href || '';
  return isGmailUrl(href);
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad_message' };
  if (!onGmail()) return { ok: false, error: 'not_gmail' };
  switch (msg.type) {
    case 'GMAIL_READ_THREAD':
      return { ok: true, thread: readThread(document) };
    case 'GMAIL_INSERT_DRAFT':
      return insertDraftIntoGmail(document, msg.body);
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      const result = handle(msg);
      if (result && typeof result.then === 'function') {
        result.then(sendResponse).catch((err) => {
          sendResponse({ ok: false, error: err?.message || 'internal_error' });
        });
        return true;
      }
      sendResponse(result);
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || 'internal_error' });
    }
    return false;
  });
}

export { handle as handleGmailContentMessage };
