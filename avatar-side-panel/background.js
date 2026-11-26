/**
 * Service worker: open the side panel, report the active tab URL, and proxy
 * aisdr avatar APIs so the panel does not need a CORS exception.
 *
 * There is no send path. This worker never POSTs /api/avatar-session.
 * Transcripts are not written here or anywhere else.
 *
 * Week 3: GMAIL_READ_THREAD and GMAIL_INSERT_DRAFT are forwarded only to a
 * mail.google.com tab's content script. This worker never clicks Send and
 * never calls a Gmail API.
 */

import { API_BASE, DEFAULT_SLUG } from './config.js';
import { siteForUrl } from './allowed-sites.js';
import { isGmailUrl } from './gmail-dom.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function tabInfo(tab) {
  const url = tab?.url || '';
  const match = siteForUrl(url);
  return {
    tabId: tab?.id ?? null,
    title: tab?.title || '',
    url,
    allowed: match.allowed,
    site: match.site ? { id: match.site.id, kind: match.site.kind, label: match.site.label } : null,
    host: match.host,
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabInfo(tab);
}

async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const url = `${API_BASE}${path}`;
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    keepalive,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

chrome.tabs.onActivated.addListener(() => {
  activeTab().then((info) => {
    chrome.runtime.sendMessage({ type: 'TAB_CHANGED', info }).catch(() => {});
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  if (!tab.active) return;
  chrome.runtime.sendMessage({ type: 'TAB_CHANGED', info: tabInfo(tab) }).catch(() => {});
});


async function gmailTabCommand(msg) {
  const [tab] = msg.tabId
    ? [await chrome.tabs.get(msg.tabId)]
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url || '';
  if (!tab?.id || !isGmailUrl(url)) {
    return { ok: false, error: 'not_gmail' };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: msg.type, body: msg.body });
  } catch {
    return { ok: false, error: 'gmail_unavailable' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object') return { error: 'bad_message' };
    switch (msg.type) {
      case 'GET_TAB':
        return activeTab();
      case 'AVATAR_CAPS': {
        const slug = encodeURIComponent(msg.slug || DEFAULT_SLUG);
        return api(`/api/avatar-caps?slug=${slug}`, { method: 'GET' });
      }
      case 'AVATAR_START':
        return api('/api/avatar-token', { method: 'POST', body: { slug: msg.slug || DEFAULT_SLUG } });
      case 'AVATAR_HEARTBEAT':
        return api('/api/avatar-session-end', {
          method: 'POST',
          body: { session_row: msg.session_row, event: 'heartbeat' },
        });
      case 'AVATAR_END':
        return api('/api/avatar-session-end', {
          method: 'POST',
          body: { session_row: msg.session_row, event: 'end' },
          keepalive: true,
        });
      case 'AVATAR_CHAT':
        return api('/api/avatar-chat', {
          method: 'POST',
          body: {
            session_row: msg.session_row,
            messages: msg.messages || [],
          },
        });
      case 'OPEN_MIC_PERMISSION': {
        const url = chrome.runtime.getURL('mic-permission.html');
        await chrome.tabs.create({ url, active: true });
        return { ok: true };
      }
      case 'GMAIL_READ_THREAD':
      case 'GMAIL_INSERT_DRAFT':
        return gmailTabCommand(msg);
      default:
        return { error: 'unknown_message' };
    }
  })().then(sendResponse).catch((err) => sendResponse({ error: err.message || 'internal_error' }));
  return true;
});
