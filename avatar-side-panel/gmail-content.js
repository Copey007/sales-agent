/**
 * Classic content script for https://mail.google.com/* only.
 *
 * Tab-only access: read the visible thread and insert a draft into the open
 * compose box (opening Reply/Compose if needed). It never clicks Send, never
 * calls a Gmail API, and never runs on any other host.
 *
 * Must stay a classic script (no import/export). MV3 content scripts ignore
 * "type": "module" and reject ESM syntax, which would leave no onMessage
 * listener ("Receiving end does not exist").
 *
 * Depends on gmail-dom-classic.js running first in the same isolated world.
 */
(function (global) {
  'use strict';

  var api = global.__AGENT_GMAIL_DOM__;

  function onGmail() {
    var href = (global.location && global.location.href) || '';
    return !!(api && api.isGmailUrl(href));
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad_message' };
    if (!api) return { ok: false, error: 'gmail_unavailable' };
    if (!onGmail()) return { ok: false, error: 'not_gmail' };
    switch (msg.type) {
      case 'GMAIL_READ_THREAD':
        return { ok: true, thread: api.readThread(global.document) };
      case 'GMAIL_INSERT_DRAFT':
        return api.insertDraftIntoGmail(global.document, msg.body);
      default:
        return { ok: false, error: 'unknown_message' };
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      try {
        var result = handle(msg);
        if (result && typeof result.then === 'function') {
          result.then(sendResponse).catch(function (err) {
            sendResponse({ ok: false, error: (err && err.message) || 'internal_error' });
          });
          return true;
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'internal_error' });
      }
      return false;
    });
  }

  global.__AGENT_GMAIL_CONTENT__ = { handle: handle };
})(typeof globalThis !== 'undefined' ? globalThis : this);
