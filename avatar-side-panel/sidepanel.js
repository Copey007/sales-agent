/**
 * A-Gent avatar side panel UI. Matches the approved design states for week 2.
 *
 * No send path. Gmail draft insertion and CRM hooks are behind disabled flags
 * and are not built here. Captions may stay visible after End in this page
 * only; they are never written to storage, disk, or the server.
 */

import { DEFAULT_SLUG, GMAIL_DRAFT_INSERT_ENABLED, CRM_HOOK_ENABLED, LIVEAVATAR_SDK_URL, LIVEAVATAR_API_URL } from './config.js';
import { siteForUrl } from './allowed-sites.js';
import { stateCopy, formatDuration } from './copy.js';

const $ = (id) => document.getElementById(id);

const state = {
  name: 'idle',
  tab: { allowed: false, host: '', url: '', site: null },
  caps: {},
  captions: [], // in-memory only; cleared when the panel document unloads
  muted: false,
  startedAt: 0,
  durationSeconds: 0,
  maxSessionSeconds: 180,
  sessionRow: null,
  sessionToken: null,
  liveSession: null,
  heartbeatTimer: null,
  tickTimer: null,
  announced30: false,
  retryAfter: 0,
  buyCreditsOpen: false,
  askText: '',
};

function icon(name, { hidden = true, label = '' } = {}) {
  const alt = label ? ` alt="${esc(label)}"` : ' alt=""';
  const aria = hidden && !label ? ' aria-hidden="true"' : (label ? ` role="img" aria-label="${esc(label)}"` : '');
  return `<img class="icon" src="icons/${name}.svg"${alt}${aria}>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      resolve({ error: 'not_in_extension' });
      return;
    }
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

function applyTab(info) {
  state.tab = info || state.tab;
  if (!state.tab.allowed && !['connecting', 'live', 'speaking', 'thinking'].includes(state.name)) {
    state.name = 'not-allowed';
  } else if (state.name === 'not-allowed' && state.tab.allowed) {
    state.name = 'idle';
  }
  render();
}

async function refreshTab() {
  const info = await send('GET_TAB');
  if (info && !info.error) applyTab(info);
  else if (typeof window !== 'undefined' && window.location) {
    applyTab({ ...siteForUrl(window.location.href), allowed: false });
  }
}

async function refreshCaps() {
  const res = await send('AVATAR_CAPS', { slug: DEFAULT_SLUG });
  if (res.status === 503 || res.data?.error === 'usage_store_unavailable') {
    return { failClosed: true, res };
  }
  if (res.ok && res.data) {
    state.caps = res.data;
    if (res.data.max_session_seconds) state.maxSessionSeconds = res.data.max_session_seconds;
    return { failClosed: false, res };
  }
  return { failClosed: false, res };
}

function stopTimers() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.heartbeatTimer = null;
  state.tickTimer = null;
}

function pushCaption(who, text) {
  if (!text) return;
  state.captions.push({ who, text, at: Date.now() });
  // In-memory only. Never persist. The list stays after End so the person can
  // reread it until they close the panel.
  render();
}

function remainingSeconds() {
  if (!state.startedAt) return state.maxSessionSeconds;
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  return Math.max(0, state.maxSessionSeconds - elapsed);
}

async function endRemote() {
  const row = state.sessionRow;
  try { await state.liveSession?.stop?.(); } catch { /* already stopping */ }
  state.liveSession = null;
  if (row) {
    try { await send('AVATAR_END', { session_row: row }); } catch { /* reaper retries */ }
  }
  state.sessionRow = null;
  state.sessionToken = null;
}

async function startSession() {
  if (!state.tab.allowed) {
    state.name = 'not-allowed';
    render();
    return;
  }
  state.name = 'connecting';
  state.buyCreditsOpen = false;
  render();
  const res = await send('AVATAR_START', { slug: DEFAULT_SLUG });
  const err = res.data?.error || (!res.ok ? 'couldnt-start' : null);
  if (err === 'quota_exceeded') {
    if (res.data) Object.assign(state.caps, res.data);
    state.name = 'monthly-cap';
    render();
    return;
  }
  if (err === 'usage_store_unavailable') {
    state.name = 'fail-closed';
    render();
    return;
  }
  if (err === 'cooldown' || err === 'rate_limited' || err === 'at_capacity') {
    state.retryAfter = Number(res.data?.retry_after) || 0;
    state.name = err === 'cooldown' ? 'cooldown' : 'too-many-starts';
    render();
    return;
  }
  if (!res.ok || !res.data?.session_token) {
    state.name = 'couldnt-start';
    render();
    return;
  }
  state.sessionToken = res.data.session_token;
  state.sessionRow = res.data.session_row;
  state.maxSessionSeconds = res.data.max_session_seconds || state.maxSessionSeconds;
  if (res.data.reset_at) state.caps.reset_at = res.data.reset_at;
  if (res.data.monthly_minute_cap != null) state.caps.monthly_minute_cap = res.data.monthly_minute_cap;
  state.startedAt = Date.now();
  state.durationSeconds = 0;
  state.announced30 = false;
  state.muted = false;
  try {
    const mod = await import(/* webpackIgnore: true */ LIVEAVATAR_SDK_URL);
    const Session = mod.LiveAvatarSession;
    const session = new Session(res.data.session_token, { voiceChat: true, apiUrl: LIVEAVATAR_API_URL });
    state.liveSession = session;
    const videoHost = $('stage-slot');
    if (videoHost) videoHost.innerHTML = '';
    if (session.attach) {
      const el = document.createElement('div');
      el.id = 'live-video';
      el.style.cssText = 'position:absolute;inset:0';
      videoHost.appendChild(el);
      await session.attach(el);
    }
    await session.start?.();
    state.name = 'live';
    startKeepalive();
    render();
  } catch (e) {
    await endRemote();
    state.name = 'couldnt-start';
    render();
  }
}

function startKeepalive() {
  stopTimers();
  state.heartbeatTimer = setInterval(async () => {
    if (!state.sessionRow) return;
    const res = await send('AVATAR_HEARTBEAT', { session_row: state.sessionRow });
    if (res.data?.event === 'stopped' || res.data?.reason === 'max_session') {
      await onTimeout();
    }
  }, 15_000);
  state.tickTimer = setInterval(() => {
    state.durationSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
    const left = remainingSeconds();
    if (left === 30 && !state.announced30) {
      state.announced30 = true;
      announceTimer('30 seconds left');
    }
    if (left <= 0) onTimeout();
    else updateTimer();
  }, 250);
}

function announceTimer(text) {
  const el = $('timer-announce');
  if (el) el.textContent = text;
}

async function onTimeout() {
  if (!['live', 'speaking', 'thinking', 'connecting'].includes(state.name)) return;
  stopTimers();
  await endRemote();
  state.name = 'session-timeout';
  render();
}

async function endSession(next = 'ended') {
  stopTimers();
  state.durationSeconds = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : state.durationSeconds;
  await endRemote();
  state.name = next;
  render();
}

async function onAsk() {
  const text = state.askText.trim();
  if (!text || !state.liveSession) return;
  state.askText = '';
  state.name = 'thinking';
  render();
  pushCaption('You', text);
  try {
    if (state.liveSession.repeat) await state.liveSession.repeat(text);
    else if (state.liveSession.speak) await state.liveSession.speak(text);
    state.name = 'speaking';
    pushCaption('A-Gent', ''); // filled by SDK events when available
    render();
    setTimeout(() => {
      if (state.name === 'speaking') {
        state.name = 'live';
        render();
      }
    }, 1500);
  } catch {
    state.name = 'live';
    render();
  }
}

async function onPrimary() {
  const s = state.name;
  if (s === 'connecting') return endSession('ended');
  if (s === 'fail-closed') {
    const { failClosed } = await refreshCaps();
    state.name = failClosed ? 'fail-closed' : (state.caps.available === false && state.caps.remaining_minutes <= 0 ? 'monthly-cap' : 'idle');
    render();
    return;
  }
  if (['idle', 'ended', 'couldnt-start', 'cooldown', 'too-many-starts', 'session-timeout'].includes(s)) {
    return startSession();
  }
}

function footerHtml(copy) {
  const inSession = ['live', 'speaking', 'thinking'].includes(state.name);
  if (inSession) {
    const left = remainingSeconds();
    const muteLabel = state.muted ? 'Unmute' : 'Mute';
    const muteIcon = state.muted ? 'mic-off' : 'mic';
    return `
      <div class="input">
        <input class="ph" id="ask-input" type="text" placeholder="Type to A-Gent" aria-label="Type to A-Gent" value="${esc(state.askText)}" autocomplete="off">
        <button class="btn sm ghost" id="ask-btn" type="button" aria-label="Ask">${icon('ask', { hidden: true })}</button>
      </div>
      <div class="ctrls">
        <button class="btn sec" id="mute-btn" type="button" aria-pressed="${state.muted ? 'true' : 'false'}">${icon(muteIcon)}${esc(muteLabel)}</button>
        <div class="timer grow" id="timer" role="timer" aria-label="Time left">${icon('clock', { hidden: true })}${formatDuration(left)}</div>
        <span class="sr-only" id="timer-announce" role="status" aria-live="polite"></span>
        <button class="btn danger" id="end-btn" type="button">${icon('end')}End</button>
      </div>`;
  }
  if (copy.action) {
    const disabled = false;
    return `<button class="btn accent lg full" id="primary-btn" type="button">${icon(state.name === 'fail-closed' ? 'retry' : 'start')}${esc(copy.action)}</button>`;
  }
  if (copy.disabledReason) {
    return `<div class="help">${icon('info')}<span>${esc(copy.disabledReason)}</span></div>
      <button class="btn accent lg full" id="primary-btn" type="button" aria-disabled="true" disabled>${icon('start')}Start conversation</button>`;
  }
  return '';
}

function contextHtml(copy) {
  const parts = [];
  if (state.buyCreditsOpen) {
    const buy = stateCopy('buy-credits', { caps: state.caps });
    parts.push(`<div class="card notice buy-placeholder" id="buy-card">
      <div class="ch">${icon('credits')}<div class="t"><b tabindex="-1" id="buy-title">${esc(buy.title)}</b></div></div>
      <div class="body">${esc(buy.message)}</div>
      <div class="row"><button class="btn sec" id="buy-dismiss" type="button">${esc(buy.action)}</button></div>
    </div>`);
  }
  if (state.name === 'monthly-cap' || state.name === 'session-timeout') {
    const ic = state.name === 'monthly-cap' ? 'calendar' : 'clock';
    parts.push(`<div class="card notice">
      <div class="ch">${icon(ic)}<div class="t"><b>${esc(copy.title)}</b><span>${esc(copy.kind || '')}</span></div></div>
      <div class="body">${esc(copy.message)}</div>
      ${copy.buyMore && !state.buyCreditsOpen ? `<div class="row"><button class="btn sec" id="buy-btn" type="button">${icon('credits')}Buy more credits</button></div>` : ''}
    </div>`);
  } else if (['couldnt-start', 'cooldown', 'too-many-starts', 'fail-closed'].includes(state.name)) {
    parts.push(`<div class="card danger" role="alert">
      <div class="ch">${icon(state.name === 'fail-closed' ? 'unavailable' : 'warning')}<div class="t"><b>${esc(copy.title || copy.pill)}</b></div></div>
      <div class="body">${esc(copy.message)}</div>
    </div>`);
  } else if (state.name === 'not-allowed') {
    parts.push(`<div class="card">
      <div class="ch">${icon('lock')}<div class="t"><b>${esc(copy.title)}</b><span>${esc(copy.host || state.tab.host || '')}</span></div></div>
      <div class="body">${esc(copy.message)}</div>
    </div>`);
  }
  // Week 3/4 cards are intentionally not rendered while the flags stay false.
  if (GMAIL_DRAFT_INSERT_ENABLED || CRM_HOOK_ENABLED) {
    /* reserved for later weeks */
  }
  return parts.join('');
}

function captionsHtml(copy) {
  if (!state.captions.length) {
    if (copy.message && ['idle', 'connecting', 'live', 'thinking', 'ended', 'speaking'].includes(state.name)) {
      const who = state.name === 'speaking' ? 'A-Gent' : state.name === 'thinking' ? 'Thinking' : state.name === 'live' ? 'Listening' : 'A-Gent';
      return `<span class="who">${esc(who)}</span>${esc(copy.message)}`;
    }
    return '';
  }
  const last = state.captions[state.captions.length - 1];
  return state.captions.map((c, i) => {
    const cls = i === state.captions.length - 1 ? '' : 'muted';
    return `<div class="${cls}"><span class="who">${esc(c.who)}</span>${esc(c.text)}</div>`;
  }).join('');
}

function stageClass() {
  if (['live', 'speaking', 'thinking'].includes(state.name)) return 'stage';
  if (['ended', 'session-timeout', 'couldnt-start', 'cooldown', 'too-many-starts', 'monthly-cap', 'fail-closed', 'not-allowed'].includes(state.name)) return 'stage gray';
  return 'stage dim';
}

function render() {
  const copy = stateCopy(state.name, {
    caps: state.caps,
    siteHost: state.tab.host,
    durationSeconds: state.durationSeconds,
    retryAfter: state.retryAfter,
  });
  const pill = $('pill');
  const pillText = $('pill-text');
  pill.className = `pill ${copy.pillKind || 'off'}`;
  pillText.textContent = copy.pill || '';
  const stage = $('stage');
  stage.className = stageClass();
  const compact = false;
  stage.setAttribute('aria-label', `A-Gent avatar, ${copy.pill || state.name}`);
  $('captions').innerHTML = captionsHtml(copy);
  $('context').innerHTML = contextHtml(copy);
  $('footer').innerHTML = footerHtml(copy) + (copy.buyMore && !['monthly-cap', 'session-timeout'].includes(state.name) ? '' : '');
  bind();
}

function bind() {
  $('primary-btn')?.addEventListener('click', () => {
    if ($('primary-btn').disabled || $('primary-btn').getAttribute('aria-disabled') === 'true') return;
    onPrimary();
  });
  $('end-btn')?.addEventListener('click', () => endSession('ended'));
  $('mute-btn')?.addEventListener('click', () => {
    state.muted = !state.muted;
    try {
      if (state.muted) state.liveSession?.mute?.();
      else state.liveSession?.unmute?.();
    } catch { /* local toggle still updates */ }
    render();
  });
  $('ask-btn')?.addEventListener('click', onAsk);
  $('ask-input')?.addEventListener('input', (e) => { state.askText = e.target.value; });
  $('ask-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      state.askText = e.target.value;
      onAsk();
    }
  });
  $('buy-btn')?.addEventListener('click', () => {
    state.buyCreditsOpen = true;
    render();
    $('buy-title')?.focus();
  });
  $('buy-dismiss')?.addEventListener('click', () => {
    state.buyCreditsOpen = false;
    render();
  });
}

function updateTimer() {
  const el = $('timer');
  if (el) {
    const left = remainingSeconds();
    el.lastChild && el.lastChild.nodeType === 3
      ? (el.lastChild.textContent = formatDuration(left))
      : null;
    // rewrite text after the icon
    const iconEl = el.querySelector('img');
    el.textContent = '';
    if (iconEl) el.appendChild(iconEl);
    el.append(formatDuration(left));
  }
}

function onPageHide() {
  if (state.sessionRow) {
    send('AVATAR_END', { session_row: state.sessionRow });
    try { state.liveSession?.stop?.(); } catch { /* closing */ }
  }
}

window.addEventListener('pagehide', onPageHide);
window.addEventListener('beforeunload', onPageHide);

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'TAB_CHANGED' && msg.info) applyTab(msg.info);
  });
}

refreshTab().then(() => refreshCaps()).then(({ failClosed }) => {
  if (failClosed && state.tab.allowed && state.name === 'idle') {
    // Stay idle; fail-closed is shown if they try Start, or they can Check again later.
  }
  render();
});

export const panelState = state;
export { startSession, endSession, applyTab, stateCopy };
