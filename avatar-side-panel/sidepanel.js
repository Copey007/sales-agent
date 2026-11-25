/**
 * A-Gent avatar side panel UI. Matches the approved design states for week 2.
 *
 * No send path. Gmail draft insertion and CRM hooks are behind disabled flags
 * and are not built here. Captions may stay visible after End in this page
 * only; they are never written to storage, disk, or the server.
 */

import { DEFAULT_SLUG, GMAIL_DRAFT_INSERT_ENABLED, CRM_HOOK_ENABLED, LIVEAVATAR_API_URL, PREVIEW_ADMIN_CREDITS } from './config.js';
import { siteForUrl } from './allowed-sites.js';
import { stateCopy, formatDuration, tbd } from './copy.js';
import { loadSdkThenMint, createLiveSession, attachToVideo, setMuted, askSession, bindTranscriptEvents } from './live-session.js';
import { ensureMicAccess } from './mic-permission.js';

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
  selectedPack: 'pack-1',
  contactAdminOpen: false,
  transcriptOpen: false,
  canBuyCredits: PREVIEW_ADMIN_CREDITS,
  signedIn: false,
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

function chipHtml(chip) {
  if (!chip) return '';
  const label = typeof chip === 'string' ? chip : chip.label;
  return `<span class="tbd">${esc(label)}</span>`;
}

function messageWithChips(copy) {
  let html = esc(copy.message || '');
  for (const c of copy.chips || []) html += chipHtml(c) + ' ';
  if (copy.messageAfter) html += esc(copy.messageAfter);
  for (const c of copy.chipsAfter || []) html += chipHtml(c);
  if (copy.messageEnd) html += esc(copy.messageEnd);
  return html;
}

function transcriptCard(copy, { collapsed = false } = {}) {
  const n = state.captions.length;
  if (!n && !copy.copyTranscript) return '';
  if (collapsed && !state.transcriptOpen) {
    return `<div class="disc"><span>Transcript · ${n} turn${n === 1 ? '' : 's'}</span>
      <button class="btn sm ghost" id="tx-show" type="button" aria-expanded="false">Show</button></div>`;
  }
  const turns = state.captions.map((c) => `<p><b>${esc(c.who)}</b>${esc(c.text)}</p>`).join('')
    || '<p class="muted">No turns in this session.</p>';
  return `<div class="card" id="tx-card">
    <div class="ch">${icon('captions')}<div class="t"><b>Transcript</b><span>This session · ${n} turn${n === 1 ? '' : 's'}. Kept in this panel only until you close it.</span></div>
      <button class="btn sm ghost" id="tx-copy" type="button">${icon('copy')}Copy</button></div>
    <div class="tx">${turns}</div>
  </div>`;
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
  if (res.status === 401 || res.status === 403 || res.data?.error === 'unauthorized' || res.data?.error === 'forbidden') {
    state.signedIn = false;
    if (!PREVIEW_ADMIN_CREDITS) state.canBuyCredits = false;
    return { failClosed: false, unauthorized: true, res };
  }
  if (res.ok && res.data) {
    state.signedIn = true;
    state.caps = res.data;
    if (res.data.max_session_seconds) state.maxSessionSeconds = res.data.max_session_seconds;
    if (typeof res.data.can_buy === 'boolean') {
      state.canBuyCredits = !!(res.data.can_buy || PREVIEW_ADMIN_CREDITS);
    }
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

  const mic = await ensureMicAccess({
    openPermissionPage: () => send('OPEN_MIC_PERMISSION'),
  });
  if (!mic.ok) {
    state.name = 'mic-needed';
    render();
    return;
  }

  let minted;
  try {
    const started = await loadSdkThenMint({
      mint: () => send('AVATAR_START', { slug: DEFAULT_SLUG }),
    });
    minted = started.minted;
    const res = minted;
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
    const session = createLiveSession(started.sdk, res.data.session_token, {
      voiceChat: true,
      apiUrl: LIVEAVATAR_API_URL,
    });
    state.liveSession = session;
    bindTranscriptEvents(session, {
      onCaption: (who, text) => pushCaption(who, text),
      onSpeak: (kind) => {
        if (kind === 'avatar-start') {
          state.name = 'speaking';
          render();
        } else if (kind === 'avatar-end' && state.name === 'speaking') {
          state.name = 'live';
          render();
        } else if (kind === 'disconnected') {
          onTimeout();
        }
      },
    });
    attachToVideo(session, $('stage-slot'));
    await session.start?.();
    state.name = 'live';
    startKeepalive();
    render();
  } catch (e) {
    if (state.sessionRow) await endRemote();
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
    askSession(state.liveSession, text);
    state.name = 'thinking';
    render();
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
  if (s === 'choose-credits') {
    // Design-only: never open a real billing page or collect a card.
    state.name = 'checkout-wait';
    render();
    return;
  }
  if (s === 'checkout-wait') {
    state.name = 'purchase-failed';
    render();
    return;
  }
  if (s === 'credits-added' || s === 'purchase-failed') {
    if (s === 'purchase-failed' && copyActionIsTryAgain()) {
      state.name = 'choose-credits';
      render();
      return;
    }
    return startSession();
  }
  if (s === 'mic-needed') {
    await send('OPEN_MIC_PERMISSION');
    return;
  }
  if (['idle', 'ended', 'couldnt-start', 'cooldown', 'too-many-starts', 'session-timeout'].includes(s)) {
    return startSession();
  }
}

function copyActionIsTryAgain() {
  return true;
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
  const buttons = [];
  if (copy.action && !copy.disabledReason) {
    const id = copy.contactAdmin && copy.action.startsWith('Contact') ? 'contact-admin-btn'
      : copy.buyMore && copy.action.startsWith('Buy') ? 'buy-btn'
      : 'primary-btn';
    const ic = copy.action.startsWith('Contact') ? 'mail'
      : copy.action.startsWith('Buy') || copy.action.startsWith('Continue') || copy.action.startsWith('Open checkout') ? 'credits'
      : state.name === 'fail-closed' ? 'retry' : 'start';
    buttons.push(`<button class="btn accent lg full" id="${id}" type="button">${icon(ic)}${esc(copy.action)}</button>`);
  }
  if (copy.secondaryAction) {
    const id = copy.secondaryAction.startsWith('Contact') ? 'contact-admin-btn'
      : copy.secondaryAction.startsWith('Buy') ? 'buy-btn'
      : copy.secondaryAction.startsWith('Cancel') ? 'cancel-btn'
      : 'secondary-btn';
    const ic = copy.secondaryAction.startsWith('Contact') ? 'mail'
      : copy.secondaryAction.startsWith('Buy') ? 'credits'
      : 'close';
    buttons.push(`<button class="btn sec lg full" id="${id}" type="button">${icon(ic)}${esc(copy.secondaryAction)}</button>`);
  }
  if (copy.disabledReason) {
    buttons.push(`<div class="help">${icon('info')}<span>${esc(copy.disabledReason)}</span></div>
      <button class="btn accent lg full" id="primary-btn" type="button" aria-disabled="true" disabled>${icon('start')}Start conversation</button>`);
  }
  return buttons.join('');
}

function contextHtml(copy) {
  const parts = [];
  if (state.contactAdminOpen) {
    const admin = stateCopy('contact-admin', { isAdmin: state.canBuyCredits });
    parts.push(`<div class="card notice" id="admin-card">
      <div class="ch">${icon('mail')}<div class="t"><b tabindex="-1" id="admin-title">${esc(admin.title)}</b></div></div>
      <div class="body">${esc(admin.message)}</div>
      <div class="row"><button class="btn sec" id="admin-dismiss" type="button">${esc(admin.action)}</button></div>
    </div>`);
  }
  if (state.name === 'choose-credits') {
    const packs = (copy.packs || []).map((pack) => {
      const sel = state.selectedPack === pack.id ? ' sel' : '';
      const checked = state.selectedPack === pack.id ? 'true' : 'false';
      return `<button class="opt${sel}" type="button" role="radio" aria-checked="${checked}" data-pack="${esc(pack.id)}">
        <span class="rd" aria-hidden="true"></span><span class="grow">${esc(pack.name)}</span>
        ${chipHtml(tbd('minutes'))}${chipHtml(tbd('price'))}
      </button>`;
    }).join('');
    parts.push(`<div class="card" id="buy-card">
      <div class="ch">${icon('credits')}<div class="t"><b tabindex="-1">${esc(copy.title)}</b><span>Packs and prices come from pricing plans</span></div></div>
      <div class="stack" role="radiogroup" aria-label="Credit pack">${packs}</div>
      <div class="help">${icon('lock')}${esc(copy.message)}</div>
    </div>`);
  } else if (state.name === 'checkout-wait' || state.name === 'credits-added' || state.name === 'purchase-failed') {
    const danger = state.name === 'purchase-failed';
    parts.push(`<div class="card ${danger ? 'danger' : 'notice'}" ${danger ? 'role="alert"' : 'role="status"'} id="buy-card">
      <div class="ch">${icon(danger ? 'warning' : 'credits')}<div class="t"><b tabindex="-1">${esc(copy.title)}</b></div></div>
      <div class="body">${messageWithChips(copy)}</div>
    </div>`);
  } else if (state.name === 'monthly-cap' || state.name === 'session-timeout') {
    const ic = state.name === 'monthly-cap' ? 'calendar' : 'clock';
    const role = state.name === 'monthly-cap' ? 'alert' : 'status';
    parts.push(`<div class="card notice" role="${role}">
      <div class="ch">${icon(ic)}<div class="t"><b>${esc(copy.title)}</b><span>${esc(copy.kind || '')}</span></div></div>
      <div class="body">${messageWithChips(copy)}</div>
    </div>`);
    parts.push(transcriptCard(copy, { collapsed: true }));
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
  } else if (state.name === 'ended') {
    parts.push(transcriptCard(copy, { collapsed: false }));
  }
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
    isAdmin: state.canBuyCredits,
    siteHost: state.tab.host,
    durationSeconds: state.durationSeconds,
    retryAfter: state.retryAfter,
    turnCount: state.captions.length,
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
  $('mute-btn')?.addEventListener('click', async () => {
    try {
      state.muted = await setMuted(state.liveSession, !state.muted);
    } catch { /* leave the previous mute state if voiceChat is missing */ }
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
    if (!state.canBuyCredits) {
      state.contactAdminOpen = true;
      render();
      $('admin-title')?.focus();
      return;
    }
    state.name = 'choose-credits';
    state.contactAdminOpen = false;
    render();
    $('buy-card')?.querySelector('b')?.focus();
  });
  $('contact-admin-btn')?.addEventListener('click', () => {
    state.contactAdminOpen = true;
    render();
    $('admin-title')?.focus();
  });
  $('admin-dismiss')?.addEventListener('click', () => {
    state.contactAdminOpen = false;
    render();
  });
  $('cancel-btn')?.addEventListener('click', () => {
    if (state.name === 'mic-needed') {
      state.name = 'idle';
      render();
      return;
    }
    state.name = state.durationSeconds > 0 ? 'session-timeout' : 'monthly-cap';
    render();
  });
  document.querySelectorAll('[data-pack]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedPack = el.getAttribute('data-pack');
      render();
    });
  });
  $('tx-show')?.addEventListener('click', () => {
    state.transcriptOpen = true;
    render();
  });
  $('tx-copy')?.addEventListener('click', async () => {
    const text = state.captions.map((c) => `${c.who}: ${c.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
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
