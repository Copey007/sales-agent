/*
 * A-Gent auth gate (2026-11 security lockdown).
 *
 * Internal dashboards used to read Supabase tables and call /api/* with only
 * the public publishable (anon) key. After the RLS lockdown those tables are
 * readable only by a signed-in platform operator, and the APIs require a user
 * JWT. This script, loaded BEFORE the page's own scripts:
 *   1. restores / refreshes a Supabase Auth session (localStorage), or shows a
 *      sign-in overlay (email + password grant);
 *   2. wraps window.fetch so every same-origin /api/* call and every
 *      <SUPABASE_URL>/rest/v1 call waits for the session and carries
 *      `Authorization: Bearer <user access token>` (apikey header unchanged).
 *
 * Usage: <script src="/auth-gate.js" data-supabase-url="https://….supabase.co"
 *                data-supabase-key="sb_publishable_…"></script>
 * The publishable key is public by design; no secrets live in this file.
 */
(function () {
  'use strict';
  var me = document.currentScript;
  var SB_URL = (me && me.dataset.supabaseUrl || '').replace(/\/$/, '');
  var SB_KEY = me && me.dataset.supabaseKey || '';
  var STORE = 'agent_auth_session_v1';
  var nativeFetch = window.fetch.bind(window);
  var session = null;
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  // The server-side edge gate (netlify/edge-functions/aisdr-gate.js) reads
  // this cookie; keep it in sync with the session so reloads stay signed in.
  function cookieDomain() {
    var h = location.hostname || '';
    if (h.length > 9 && h.slice(-10) === '.a-gent.co') return '; Domain=.a-gent.co';
    return '';
  }
  function writeCookie(name, value, maxAge, withDomain) {
    document.cookie = name + '=' + encodeURIComponent(value || '') + '; Path=/; Max-Age=' + Math.max(0, maxAge | 0) + '; Secure; SameSite=Lax' + (withDomain ? cookieDomain() : '');
  }
  function setAuthCookies(s) {
    var maxAge = s ? Math.max(0, (s.expires_at | 0) - Math.floor(Date.now() / 1000)) : 0;
    writeCookie('agent_at', s && s.access_token, maxAge, true);
    writeCookie('agent_rt', s && s.refresh_token, maxAge, true);
  }
  function clearAuthCookies() {
    writeCookie('agent_at', '', 0, true);
    writeCookie('agent_at', '', 0, false);
    writeCookie('agent_rt', '', 0, true);
    writeCookie('agent_rt', '', 0, false);
  }
  function readCookie(name) {
    var all = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < all.length; i++) {
      var part = all[i];
      var j = part.indexOf('=');
      if (j < 0) continue;
      if (part.slice(0, j).trim() === name) {
        try { return decodeURIComponent(part.slice(j + 1).trim()); } catch (e) { return ''; }
      }
    }
    return '';
  }
  function setCookie(s) {
    if (s && s.access_token) setAuthCookies(s);
    else clearAuthCookies();
  }
  function save(s) {
    session = s;
    try { if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE); } catch (e) {}
    setCookie(s);
  }
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function withExpiry(t) {
    if (!t || !t.access_token) return null;
    return { access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: t.expires_at || (Math.floor(Date.now() / 1000) + (t.expires_in || 3600)),
      email: (t.user && t.user.email) || t.email || '' };
  }
  function tokenGrant(type, body) {
    return nativeFetch(SB_URL + '/auth/v1/token?grant_type=' + type, {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error_description || j.msg || j.error || 'Sign-in failed'); return j; }); });
  }
  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('no session'));
    return tokenGrant('refresh_token', { refresh_token: session.refresh_token }).then(function (t) {
      var s = withExpiry(t); if (s && !s.email) s.email = session.email; save(s); return s;
    });
  }
  function validToken() {
    if (!session) return ready.then(validToken);
    if (session.expires_at - 60 > Date.now() / 1000) return Promise.resolve(session.access_token);
    return refresh().then(function (s) { return s.access_token; }, function () { signOut(); return ready.then(validToken); });
  }

  function needsAuth(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === location.origin && u.pathname.indexOf('/api/') === 0) return true;
      if (SB_URL && (u.origin + u.pathname).indexOf(SB_URL + '/rest/v1') === 0) return true;
    } catch (e) {}
    return false;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!needsAuth(url)) return nativeFetch(input, init);
    return validToken().then(function (tok) {
      init = init || {};
      var h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      h.set('Authorization', 'Bearer ' + tok);
      if (SB_URL && url.indexOf(SB_URL) === 0 && !h.has('apikey')) h.set('apikey', SB_KEY);
      var next = Object.assign({}, init, { headers: h });
      return nativeFetch(input, next).then(function (res) {
        if (res.status === 401) { signOut(); }
        return res;
      });
    });
  };

  // ── Sign-in overlay ──────────────────────────────────────────────────────
  var overlay;
  // Never paint the dashboard shell for a signed-out visitor.
  function hideApp(on) {
    var el = document.getElementById('agent-auth-hide');
    if (on && !el) {
      el = document.createElement('style'); el.id = 'agent-auth-hide';
      el.textContent = 'body > *:not(#agent-auth-gate){visibility:hidden !important}';
      document.head.appendChild(el);
    } else if (!on && el) { el.remove(); }
  }
  function showLogin(msg) {
    hideApp(true);
    if (overlay) { overlay.style.display = 'grid'; setMsg(msg); return; }
    overlay = document.createElement('div');
    overlay.id = 'agent-auth-gate';
    overlay.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:rgba(16,35,29,.92);font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif');
    overlay.innerHTML =
      '<style>#agent-auth-gate :focus-visible{outline:2px solid #c8f04a;outline-offset:2px}#agent-auth-gate input:hover{border-color:#8a8a90 !important}</style>' +
      '<main aria-labelledby="agent-auth-title"><form style="background:#16302a;border:1px solid rgb(255 255 255 / .14);border-radius:14px;padding:28px;width:min(360px,90vw);color:#f3f4f0;box-shadow:0 20px 60px rgba(0,0,0,.5)">' +
      '<h1 id="agent-auth-title" style="margin:0 0 6px;font-size:20px">Sign in to AskArlen</h1>' +
      '<p style="margin:0 0 18px;color:#c5d5ce;font-size:13px">Operator access only.</p>' +
      '<label for="agent-auth-email" style="display:block;font-size:12px;color:#c5d5ce">Email</label>' +
      '<input id="agent-auth-email" name="email" type="email" autocomplete="username" required style="width:100%;box-sizing:border-box;margin:4px 0 12px;padding:10px;border-radius:8px;border:1px solid #6b6b70;background:#0a0a0c;color:#f0f0f2;font-family:inherit">' +
      '<label for="agent-auth-password" style="display:block;font-size:12px;color:#c5d5ce">Password</label>' +
      '<input id="agent-auth-password" name="password" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box;margin:4px 0 16px;padding:10px;border-radius:8px;border:1px solid #6b6b70;background:#0a0a0c;color:#f0f0f2;font-family:inherit">' +
      '<button type="submit" style="width:100%;padding:11px;border:0;border-radius:8px;background:#c8f04a;color:#10231d;font-family:inherit;font-weight:600;cursor:pointer">Sign in</button>' +
      '<p data-msg role="alert" style="min-height:18px;margin:12px 0 0;color:#d4625a;font-size:13px"></p></form></main>';
    var form = overlay.querySelector('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      setMsg('');
      var email = form.email.value.trim(), password = form.password.value;
      tokenGrant('password', { email: email, password: password }).then(function (t) {
        var s = withExpiry(t); if (!s) throw new Error('Sign-in failed');
        if (!s.email) s.email = email;
        save(s); form.password.value = ''; overlay.style.display = 'none'; hideApp(false); badge(); readyResolve();
      }).catch(function (err) { setMsg(err.message); });
    });
    (document.body || document.documentElement).appendChild(overlay);
    setMsg(msg);
  }
  function setMsg(m) { if (overlay) overlay.querySelector('[data-msg]').textContent = m || ''; }

  function signOut() {
    var had = !!session;
    save(null);
    ready = new Promise(function (r) { readyResolve = r; });
    var b = document.getElementById('agent-auth-badge'); if (b) b.remove();
    whenBody(function () { showLogin(had ? 'Session expired — please sign in again.' : ''); });
  }
  function badge() {
    if (document.getElementById('agent-auth-badge') || !session) return;
    var b = document.createElement('div');
    b.id = 'agent-auth-badge';
    b.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:2147483645;background:#16302a;border:1px solid rgb(255 255 255 / .14);color:#c5d5ce;font:12px "Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif;padding:6px 10px;border-radius:999px');
    b.textContent = (session.email || 'signed in') + ' · ';
    var a = document.createElement('a'); a.href = '#'; a.textContent = 'Sign out'; a.style.color = '#f0f0f2';
    a.addEventListener('click', function (e) {
      e.preventDefault();
      nativeFetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + (session && session.access_token) } }).catch(function () {});
      signOut();
    });
    b.appendChild(a); document.body.appendChild(b);
  }
  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }

  window.AGENT_AUTH = { ready: function () { return ready; }, token: validToken, signOut: signOut };

  // ── Boot ─────────────────────────────────────────────────────────────────
  if (!SB_URL || !SB_KEY) { console.error('[auth-gate] missing data-supabase-url / data-supabase-key'); }
  session = load();
  if (!(session && session.refresh_token)) {
    var rt = readCookie('agent_rt');
    if (rt) session = { refresh_token: rt, email: (session && session.email) || '', access_token: (session && session.access_token) || '', expires_at: 0 };
  }
  if (session && session.expires_at - 60 > Date.now() / 1000) { readyResolve(); whenBody(badge); }
  else if (session && session.refresh_token) {
    refresh().then(function () { readyResolve(); whenBody(badge); }, function () { signOut(); });
  } else { save(null); hideApp(true); whenBody(function () { showLogin(''); }); }
})();
