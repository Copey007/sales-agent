/**
 * LiveAvatar web SDK 0.0.18 helpers for the side panel.
 *
 * Load the locally bundled SDK first, then mint a token. Never the reverse:
 * a failed SDK load must not spend a LiveAvatar mint.
 *
 * Session shape (from @heygen/liveavatar-web-sdk@0.0.18):
 *   session.attach(HTMLMediaElement)
 *   session.repeat(text)             // speak a reply verbatim (A-Gent brain, then talk)
 *   session.message(text)            // LiveAvatar's own AI — do not use for Ask
 *   session.voiceChat.mute() / unmute() / isMuted
 *   events: user.transcription, avatar.transcription, avatar.speak_started/ended
 */

export const SDK_MODULE_PATH = './vendor/liveavatar-web-sdk.js';
export const SDK_VERSION = '0.0.18';

export const AgentEvents = {
  USER_TRANSCRIPTION: 'user.transcription',
  USER_TRANSCRIPTION_CHUNK: 'user.transcription.chunk',
  AVATAR_TRANSCRIPTION: 'avatar.transcription',
  AVATAR_TRANSCRIPTION_CHUNK: 'avatar.transcription.chunk',
  USER_SPEAK_STARTED: 'user.speak_started',
  USER_SPEAK_ENDED: 'user.speak_ended',
  AVATAR_SPEAK_STARTED: 'avatar.speak_started',
  AVATAR_SPEAK_ENDED: 'avatar.speak_ended',
};

export const SessionEvent = {
  SESSION_STREAM_READY: 'session.stream_ready',
  SESSION_DISCONNECTED: 'session.disconnected',
};

let _sdkPromise = null;

/** Dynamic import of the local vendor bundle. No remote URLs. */
export function loadLiveAvatarSdk(importer = (path) => import(path)) {
  if (!_sdkPromise) {
    _sdkPromise = Promise.resolve(importer(SDK_MODULE_PATH));
  }
  return _sdkPromise;
}

/** Test helper: drop the cached module promise. */
export function resetSdkLoader() {
  _sdkPromise = null;
}

/**
 * Load the SDK, then call mint(). If the SDK fails, mint is never called.
 */
export async function loadSdkThenMint({ loadSdk = loadLiveAvatarSdk, mint } = {}) {
  if (typeof mint !== 'function') throw new Error('mint_required');
  const sdk = await loadSdk();
  if (!sdk?.LiveAvatarSession) throw new Error('sdk_unavailable');
  const minted = await mint();
  return { sdk, minted };
}

export function isVideoElement(el) {
  if (!el) return false;
  const name = String(el.tagName || el.nodeName || '').toUpperCase();
  return name === 'VIDEO' || (typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement);
}

/**
 * Attach after session.start(), on session.stream_ready, the way agent.html
 * does. Calling attach() earlier throws "Stream is not yet ready".
 */
export function startAndAttach(session, host, { createElement, start = (s) => s.start() } = {}) {
  if (!session || typeof start !== 'function') throw new Error('start_unavailable');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const onReady = () => {
      try {
        done(resolve, attachToVideo(session, host, { createElement }));
      } catch (err) {
        done(reject, err);
      }
    };
    if (typeof session.on === 'function') {
      session.on(SessionEvent.SESSION_STREAM_READY, onReady);
    } else {
      done(reject, new Error('stream_ready_unavailable'));
      return;
    }
    Promise.resolve(start(session)).catch((err) => done(reject, err));
  });
}

/** Attach the remote stream to a <video> element inside host. */
export function attachToVideo(session, host, { createElement } = {}) {
  if (!session || typeof session.attach !== 'function') throw new Error('attach_unavailable');
  const make = createElement || ((tag) => document.createElement(tag));
  let video = host && typeof host.querySelector === 'function' ? host.querySelector('video') : null;
  if (!isVideoElement(video)) {
    video = make('video');
    if (host) {
      host.innerHTML = '';
      host.appendChild(video);
    }
  }
  video.id = 'live-video';
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', ''); // page autoplay; avatar audio is attached by the SDK
  session.attach(video);
  return video;
}

export async function setMuted(session, muted) {
  const vc = session?.voiceChat;
  if (!vc || typeof vc.mute !== 'function' || typeof vc.unmute !== 'function') {
    throw new Error('voice_chat_unavailable');
  }
  if (muted) await vc.mute();
  else await vc.unmute();
  return !!vc.isMuted;
}

/** Speak an A-Gent reply verbatim. Do not use session.message() — that is LiveAvatar's own AI. */
export function speakReply(session, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (typeof session?.repeat !== 'function') throw new Error('repeat_unavailable');
  return session.repeat(trimmed);
}

/**
 * Ask A-Gent's concierge (avatar_agents system_prompt + knowledge, default
 * claude-haiku-4-5) then have the avatar speak the reply with repeat().
 */
export async function askAGent({ text, history = [], slug, askConcierge, session } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (typeof askConcierge !== 'function') throw new Error('concierge_required');
  const messages = [...history, { role: 'user', content: trimmed }];
  const reply = String(await askConcierge({
    action: 'chat',
    slug,
    messages,
    speak: false,
  }) || '').trim();
  if (session && reply) speakReply(session, reply);
  return reply;
}

/**
 * Single-flight session teardown: stop() throws are swallowed, and AVATAR_END
 * is sent at most once for a given ender until reset().
 */
export function createSessionEnder() {
  let inflight = null;
  return {
    reset() { inflight = null; },
    async end({ session, row, stop, sendEnd } = {}) {
      if (inflight) return inflight;
      inflight = (async () => {
        const stopFn = stop || ((s) => s?.stop?.());
        try { await Promise.resolve(stopFn(session)); } catch { /* SDK stop throw */ }
        if (row && typeof sendEnd === 'function') await sendEnd(row);
      })();
      return inflight;
    },
  };
}

function eventText(ev) {
  if (!ev) return '';
  if (typeof ev === 'string') return ev;
  return String(ev.text || ev.data?.text || ev.transcript || '').trim();
}

/**
 * Subscribe to SDK transcription and speak events. Captions go to onCaption
 * (in-memory only). Spoken user turns and avatar replies are included.
 */
export function bindTranscriptEvents(session, { onCaption, onSpeak } = {}) {
  if (!session || typeof session.on !== 'function') return () => {};
  const handlers = [];
  const on = (ev, fn) => {
    session.on(ev, fn);
    handlers.push([ev, fn]);
  };
  on(AgentEvents.USER_TRANSCRIPTION, (ev) => {
    const text = eventText(ev);
    if (text) onCaption?.('You', text);
  });
  // Do not listen for avatar.transcription: the concierge/avatar-chat reply
  // is already added to the in-memory transcript, and repeat() would duplicate it.
  on(AgentEvents.AVATAR_SPEAK_STARTED, () => onSpeak?.('avatar-start'));
  on(AgentEvents.AVATAR_SPEAK_ENDED, () => onSpeak?.('avatar-end'));
  on(AgentEvents.USER_SPEAK_STARTED, () => onSpeak?.('user-start'));
  on(AgentEvents.USER_SPEAK_ENDED, () => onSpeak?.('user-end'));
  on(SessionEvent.SESSION_DISCONNECTED, (reason) => onSpeak?.('disconnected', reason));
  return () => {
    if (typeof session.off === 'function') {
      for (const [ev, fn] of handlers) session.off(ev, fn);
    }
  };
}

export function createLiveSession(sdk, token, { voiceChat = true, apiUrl } = {}) {
  const Session = sdk?.LiveAvatarSession;
  if (!Session) throw new Error('sdk_unavailable');
  return new Session(token, { voiceChat, apiUrl });
}
