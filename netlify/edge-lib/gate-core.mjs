/**
 * Server-side auth gate core (shared by aisdr + Mission Control edge functions).
 * Runtime-agnostic (works in Netlify Edge/Deno and in Node tests): no Deno or
 * Netlify globals — everything comes in through `deps`.
 *
 * Flow:
 *   1. Read the Supabase access token from the `agent_at` cookie (set by the
 *      login shell / in-app session code) or an `Authorization: Bearer` header.
 *   2. Verify it server-side against Supabase Auth GET /auth/v1/user.
 *   3. Valid (and, if required, an allowlisted operator) → serve the protected
 *      page via next(), marked no-store. Otherwise → a small public login shell
 *      (401) that contains NONE of the protected app markup or script.
 *
 * The login shell embeds only the PUBLIC publishable/anon key. It refuses to
 * render (503) if the configured key looks like a service-role/secret key.
 */

export const COOKIE = 'agent_at';

export const COOKIE_RT = 'agent_rt';
export const SHARED_COOKIE_DOMAIN = '.a-gent.co';
/** Umbrella cookie domains: each registrable parent gets its OWN shared cookie. */
export const SSO_COOKIE_DOMAINS = ['.a-gent.co', '.askarlen.com'];

/**
 * Shared cookie Domain for module subdomains:
 *   *.a-gent.co    (aisdr, fleet, legacy missioncontrol) -> Domain=.a-gent.co
 *   *.askarlen.com (missioncontrol)                      -> Domain=.askarlen.com
 * Host-only ('') for localhost, *.netlify.app previews, and the apex marketing
 * sites (`"a-gent.co".endsWith(".a-gent.co")` is false). Browsers can never set
 * a cookie across the two registrable domains, so cross-domain SSO uses the
 * fragment handoff (/auth/handoff) below.
 * document.cookie cannot set HttpOnly; server Set-Cookie helpers below do.
 */
export function sharedCookieDomain(host) {
  const h = String(host || '').split(':')[0].trim().toLowerCase().replace(/\.$/, '');
  for (const d of SSO_COOKIE_DOMAINS) {
    if (h.length > d.length && h.endsWith(d)) return d;
  }
  return '';
}

/** Hosts that serve /auth/handoff + /auth/logout (cross-domain SSO peers). */
export const SSO_PEER_HOSTS = ['aisdr.a-gent.co', 'missioncontrol.askarlen.com'];
/** Netlify sites whose *.netlify.app / deploy-preview hosts may be a logout `next`. */
const NETLIFY_SITES = ['magenta-kleicha-c9a1e6', 'a-gent-ai-sdr'];

/** True if `host` belongs to the AskArlen / A-Gent umbrella (safe redirect target). */
export function isUmbrellaHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'a-gent.co' || h === 'askarlen.com') return true;
  if (sharedCookieDomain(h)) return true;
  return NETLIFY_SITES.some((s) => h === `${s}.netlify.app` || h.endsWith(`--${s}.netlify.app`));
}

/**
 * Open-redirect-safe `next`: a same-origin path ("/x", never "//x" or "/\\x"),
 * or an absolute https URL on an umbrella host. Anything else -> fallback.
 */
export function safeNext(next, fallback = '/') {
  const n = String(next || '').trim();
  if (!n) return fallback;
  if (n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\')) return n;
  try {
    const u = new URL(n);
    if (u.protocol === 'https:' && !u.username && !u.password && isUmbrellaHost(u.hostname)) return u.href;
  } catch { /* fallthrough */ }
  return fallback;
}

/**
 * Canonical-host 301 (runs in the edge gate BEFORE auth, because Netlify edge
 * functions run before netlify.toml redirects). Preserves path + query.
 * Returns a Response or null.
 */
export function canonicalRedirect(request, map) {
  if (!map) return null;
  let u;
  try { u = new URL(request.url); } catch { return null; }
  const to = map[u.hostname.toLowerCase()];
  if (!to) return null;
  const status = (request.method === 'GET' || request.method === 'HEAD') ? 301 : 308;
  return new Response(null, { status, headers: { Location: `https://${to}${u.pathname}${u.search}`, 'Cache-Control': 'no-store', ...SHELL_SECURITY } });
}

/** Attribute suffix for a Set-Cookie / document.cookie assignment. */
export function cookieAttributeSuffix({ maxAge = 0, domain = '', httpOnly = false } = {}) {
  let s = `Path=/; Max-Age=${Math.max(0, maxAge | 0)}; Secure; SameSite=Lax`;
  if (domain) s += `; Domain=${domain}`;
  if (httpOnly) s += '; HttpOnly';
  return s;
}

/**
 * Two Set-Cookie values that expire a cookie: the shared Domain=.a-gent.co
 * variant (when applicable) AND the host-only legacy variant, so a stale
 * host-only cookie can never shadow the shared one after sign-out.
 */
export function clearCookieSetCookieValues(name, host, { httpOnly = true } = {}) {
  const n = String(name || '').trim();
  if (!n) return [];
  const domain = sharedCookieDomain(host);
  const out = [`${n}=; ${cookieAttributeSuffix({ maxAge: 0, domain: '', httpOnly })}`];
  if (domain) out.unshift(`${n}=; ${cookieAttributeSuffix({ maxAge: 0, domain, httpOnly })}`);
  return out;
}

export function setCookieValue(name, value, host, { maxAge = 0, httpOnly = true } = {}) {
  const domain = sharedCookieDomain(host);
  return `${name}=${encodeURIComponent(value || '')}; ${cookieAttributeSuffix({ maxAge, domain, httpOnly })}`;
}

export function clearAuthCookieSetCookieValues(host, { httpOnly = true } = {}) {
  return [
    ...clearCookieSetCookieValues(COOKIE, host, { httpOnly }),
    ...clearCookieSetCookieValues(COOKIE_RT, host, { httpOnly }),
  ];
}

export function readToken(request) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

/** True if a key must never be shipped to a browser. */
export function isPrivilegedKey(key) {
  if (!key) return true;
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
      if (json.role === 'service_role') return true;
    } catch { /* not a JWT */ }
  }
  return false;
}

export function operatorSet(raw) {
  return new Set(String(raw || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export async function verifyUser(token, { supabaseUrl, publicKey, fetchImpl }) {
  if (!token || !supabaseUrl || !publicKey) return null;
  try {
    const res = await fetchImpl(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: publicKey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch { return null; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Parse Supabase auth callback params from a query string and/or hash. */
export function parseAuthCallback(search = '', hash = '') {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const pick = (k) => h.get(k) || q.get(k) || '';
  return {
    type: pick('type'),
    access_token: pick('access_token'),
    refresh_token: pick('refresh_token'),
    expires_in: Number(pick('expires_in') || 0) || 3600,
    error: pick('error_description') || pick('error'),
  };
}

/**
 * Browser copy of sharedCookieDomain() (embedded in every login/handoff/logout
 * page and mirrored in index.html / auth-gate.js; tests keep them in sync).
 */
export const CLIENT_COOKIE_DOMAIN_JS = "function cookieDomain(){var h=(location.hostname||'').toLowerCase();var d=['.a-gent.co','.askarlen.com'];for(var i=0;i<d.length;i++){if(h.length>d[i].length&&h.slice(-d[i].length)===d[i])return '; Domain='+d[i];}return '';}";
const CLIENT_COOKIE_HELPERS_JS = CLIENT_COOKIE_DOMAIN_JS +
  "function writeCookie(name,value,maxAge,withDomain){document.cookie=name+'='+encodeURIComponent(value||'')+'; Path=/; Max-Age='+Math.max(0,maxAge|0)+'; Secure; SameSite=Lax'+(withDomain?cookieDomain():'');}" +
  "function clearAuthCookies(){writeCookie('agent_at','',0,true);writeCookie('agent_at','',0,false);writeCookie('agent_rt','',0,true);writeCookie('agent_rt','',0,false);}";

/** localStorage keys that hold a copy of the session on umbrella hosts. */
export const SESSION_STORAGE_KEYS = ['mc_session', 'agent_auth_session_v1'];

const MINI_STYLE = '<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif;background:#10231d;color:#f3f4f0}main{text-align:center;padding:24px}a{color:#c8f04a}</style>';

/**
 * Cross-domain SSO handoff target (GET /auth/handoff#rt=<refresh>&next=<path>).
 * The refresh token travels ONLY in the URL fragment (never sent to any server,
 * never in logs or Referer). The page strips the fragment immediately with
 * history.replaceState, redeems the token with Supabase (refresh grant — which
 * also rotates it, so the URL value is single-use), writes this domain's own
 * cookies + localStorage, and continues to a same-origin path.
 */
export function handoffPage({ supabaseUrl, publicKey, storageKey }) {
  const cfg = JSON.stringify({ url: supabaseUrl.replace(/\/$/, ''), key: publicKey, storageKey })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Signing you in · AskArlen</title>${MINI_STYLE}</head>
<body><main><p id="msg" role="status">Signing you in…</p></main>
<script>
(function(){
var C=${cfg};
${CLIENT_COOKIE_HELPERS_JS}
function parseHandoff(hash){var hs=String(hash||'');if(hs.charAt(0)==='#')hs=hs.slice(1);var p=new URLSearchParams(hs);return{rt:p.get('rt')||'',next:p.get('next')||'/'};}
function samePath(n){n=String(n||'/');return(n.charAt(0)==='/'&&n.charAt(1)!=='/'&&n.charAt(1)!=='\\\\')?n:'/';}
var h=parseHandoff(location.hash);
try{history.replaceState(null,'',location.pathname);}catch(e){}
var next=samePath(h.next);
if(!h.rt){location.replace(next);return;}
fetch(C.url+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:C.key,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:h.rt})})
 .then(function(r){return r.json().then(function(j){if(!r.ok||!j.access_token)throw new Error('handoff');return j;});})
 .then(function(d){var exp=d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600);var age=exp-Math.floor(Date.now()/1000);
  var s={access_token:d.access_token,refresh_token:d.refresh_token,expires_at:exp,email:(d.user&&d.user.email)||''};
  try{localStorage.setItem(C.storageKey,JSON.stringify(s));sessionStorage.removeItem('gate_refresh_tried');}catch(e){}
  writeCookie('agent_at',s.access_token,age,true);writeCookie('agent_rt',s.refresh_token,age,true);location.replace(next);})
 .catch(function(){clearAuthCookies();location.replace(next);});
})();
</script></body></html>`;
}

/**
 * Sign-out leg on this domain (GET /auth/logout?next=<url>): clears this
 * domain's auth cookies (shared Domain + host-only variants, also via
 * Set-Cookie) and every local session copy, then continues to an
 * umbrella-only `next` (open-redirect safe). It never chains further.
 */
export function logoutPage({ next }) {
  const cfg = JSON.stringify({ next, keys: SESSION_STORAGE_KEYS }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Signing out · AskArlen</title>${MINI_STYLE}</head>
<body><main><p role="status">Signing you out…</p></main>
<script>
(function(){
var C=${cfg};
${CLIENT_COOKIE_HELPERS_JS}
clearAuthCookies();
try{for(var i=0;i<C.keys.length;i++)localStorage.removeItem(C.keys[i]);sessionStorage.removeItem('gate_refresh_tried');}catch(e){}
location.replace(C.next);
})();
</script></body></html>`;
}

export function loginShell({ title, subtitle, supabaseUrl, publicKey, storageKey, allowSignup = false, signupUrl = '', message = '', manifest = '/site-aisdr.webmanifest', reviewUrl = '' }) {
  const cfg = JSON.stringify({ url: supabaseUrl.replace(/\/$/, ''), key: publicKey, storageKey, cookie: COOKIE })
    .replace(/</g, '\\u003c');
  const review = reviewUrl ? `<div class="alt"><a href="${esc(reviewUrl)}">Review outreach in Mission Control</a></div>` : '';
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="${esc(manifest)}"><meta name="theme-color" content="#10231d">
<title>Sign in · ${esc(title)}</title>
<style>
:root{color-scheme:dark;--forest:#10231d;--green:#0e6b54;--lime:#c8f04a;--paper:#f3f4f0;--font-sans:"Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:var(--font-sans);background:#10231d;color:#f3f4f0}
main{width:min(380px,calc(100% - 32px));background:#16302a;border:1px solid rgb(255 255 255 / .14);border-radius:16px;padding:28px}
.mark{display:flex;align-items:center;gap:10px;margin:0 0 18px}
.mark svg{width:32px;height:32px;display:block;flex-shrink:0;border-radius:8px}
.mark span{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#c8f04a}
h1{margin:0 0 6px;font-size:1.3rem;font-weight:700;color:#f3f4f0}p{margin:0 0 18px;color:#c5d5ce;font-size:.9rem}
label{display:block;font-size:.8rem;color:#c5d5ce;margin:0 0 4px}
input{width:100%;margin:0 0 14px;padding:10px 12px;border-radius:10px;border:1px solid #729184;background:#0b1813;color:#f3f4f0;font:inherit}
input:hover{border-color:#8a8a90}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #c8f04a;outline-offset:2px}
button{width:100%;padding:11px;border:0;border-radius:10px;background:#c8f04a;color:#10231d;font:600 .95rem/1.2 "Plus Jakarta Sans",ui-sans-serif,system-ui,sans-serif;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}#msg{min-height:1.2em;margin:12px 0 0;color:#d4625a;font-size:.85rem}
a{color:#c8f04a}.alt{margin-top:14px;text-align:center;font-size:.85rem}
.hid{display:none}#msg.ok{color:#8fd9a8}
</style></head>
<body><main aria-labelledby="t"><div class="mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="AskArlen"><title>AskArlen</title><rect width="32" height="32" rx="8" fill="#c8f04a"/><path d="M9 23L23 9M23 9h-9M23 9v9" stroke="#10231d" stroke-width="3" fill="none" stroke-linecap="round"/></svg><span>AskArlen</span></div><h1 id="t">${esc(title)}</h1><p>${esc(subtitle)}</p>
<form id="f" novalidate>
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button id="b" type="submit">Sign in</button>
</form>
<form id="forgotF" class="hid" novalidate>
<label for="remail">Email</label><input id="remail" name="email" type="email" autocomplete="username" required>
<button id="rb" type="submit">Send reset link</button>
</form>
<form id="resetF" class="hid" novalidate>
<label for="npw">New password</label><input id="npw" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="npw2">Confirm password</label><input id="npw2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
<button id="sb" type="submit">Set new password</button>
</form>
<div id="msg" role="alert" aria-live="polite">${esc(message)}</div>
<p class="alt" id="forgotWrap"><a href="#forgot" id="forgot">Forgot password?</a></p>
<p class="alt hid" id="backWrap"><a href="#signin" id="back">Back to sign in</a></p>
${review}${allowSignup && signupUrl ? `<div class="alt">New here? <a href="${esc(signupUrl)}">Create an account</a></div>` : ''}
</main>
<script>
(function(){
var C=${cfg};
${CLIENT_COOKIE_DOMAIN_JS}
function writeCookie(name,value,maxAge,withDomain){document.cookie=name+'='+encodeURIComponent(value||'')+'; Path=/; Max-Age='+Math.max(0,maxAge|0)+'; Secure; SameSite=Lax'+(withDomain?cookieDomain():'');}
function setAuthCookies(at,rt,maxAge){writeCookie(C.cookie,at||'',maxAge,true);writeCookie('agent_rt',rt||'',maxAge,true);}
function clearAuthCookies(){writeCookie(C.cookie,'',0,true);writeCookie(C.cookie,'',0,false);writeCookie('agent_rt','',0,true);writeCookie('agent_rt','',0,false);}
function readCookie(name){var all=document.cookie?document.cookie.split(';'):[];for(var i=0;i<all.length;i++){var p=all[i];var j=p.indexOf('=');if(j<0)continue;if(p.slice(0,j).trim()===name){try{return decodeURIComponent(p.slice(j+1).trim());}catch(e){return '';}}}return '';}
function store(d,email){var s={access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),email:email||(d.user&&d.user.email)||''};
 try{localStorage.setItem(C.storageKey,JSON.stringify(s));}catch(e){} setAuthCookies(s.access_token,s.refresh_token,s.expires_at-Math.floor(Date.now()/1000));}
function grant(type,body){return fetch(C.url+'/auth/v1/token?grant_type='+type,{method:'POST',headers:{apikey:C.key,'Content-Type':'application/json'},body:JSON.stringify(body)})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error_description||j.msg||'Invalid email or password.');return j;});});}
function pick(h,q,k){return h.get(k)||q.get(k)||'';}
function cb(){var hs=location.hash||'';if(hs.charAt(0)==='#')hs=hs.slice(1);var h=new URLSearchParams(hs);var q=new URLSearchParams(location.search||'');return{type:pick(h,q,'type'),access_token:pick(h,q,'access_token'),refresh_token:pick(h,q,'refresh_token'),expires_in:Number(pick(h,q,'expires_in')||0)||3600,error:pick(h,q,'error_description')||pick(h,q,'error')};}
function show(id){['f','forgotF','resetF'].forEach(function(x){var el=document.getElementById(x);if(el)el.style.display=x===id?'block':'none';});
 document.getElementById('forgotWrap').style.display=id==='f'?'block':'none';
 document.getElementById('backWrap').className=id==='f'?'alt hid':'alt';}
var f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('msg');
var rec=cb();
if(rec.error){m.textContent=rec.error;try{history.replaceState({},'',location.pathname);}catch(e){}}
if(rec.type==='recovery'&&rec.access_token){show('resetF');m.textContent='Choose a new password.';m.className='ok';}
else if((location.hash||'')==='#forgot'){show('forgotF');}
else {
  // Seamless renewal: an existing local session with a refresh token re-issues the cookie.
  try{var s=JSON.parse(localStorage.getItem(C.storageKey)||'null');
   if(!(s&&s.refresh_token)){var rt=readCookie('agent_rt');if(rt)s={refresh_token:rt,email:(s&&s.email)||''};}
   if(s&&s.refresh_token&&!sessionStorage.getItem('gate_refresh_tried')){sessionStorage.setItem('gate_refresh_tried','1');
    grant('refresh_token',{refresh_token:s.refresh_token}).then(function(d){store(d,s.email);location.reload();},function(){try{localStorage.removeItem(C.storageKey);}catch(e){} clearAuthCookies();});}}catch(e){}
}
document.getElementById('forgot').addEventListener('click',function(e){e.preventDefault();show('forgotF');m.textContent='';m.className='';});
document.getElementById('back').addEventListener('click',function(e){e.preventDefault();show('f');m.textContent='';m.className='';});
f.addEventListener('submit',function(e){e.preventDefault();m.className='';m.textContent='';var email=f.email.value.trim(),pw=f.password.value;
 if(!email||!pw){m.textContent='Enter your email and password.';return;}
 b.disabled=true;b.textContent='Signing in…';
 grant('password',{email:email,password:pw}).then(function(d){store(d,email);sessionStorage.removeItem('gate_refresh_tried');location.reload();},
 function(err){m.textContent=err.message;b.disabled=false;b.textContent='Sign in';});});
document.getElementById('forgotF').addEventListener('submit',function(e){e.preventDefault();m.className='';m.textContent='';
 var email=document.getElementById('remail').value.trim(); if(!email){m.textContent='Enter your email.';return;}
 var rb=document.getElementById('rb'); rb.disabled=true; rb.textContent='Sending…';
 var dest=encodeURIComponent(location.origin+location.pathname);
 fetch(C.url+'/auth/v1/recover?redirect_to='+dest,{method:'POST',headers:{apikey:C.key,'Content-Type':'application/json'},body:JSON.stringify({email:email})})
  .then(function(){m.className='ok';m.textContent='If an account exists for that email, a reset link is on its way.';rb.disabled=false;rb.textContent='Send reset link';})
  .catch(function(){m.textContent='Could not send a reset link. Try again.';rb.disabled=false;rb.textContent='Send reset link';});});
document.getElementById('resetF').addEventListener('submit',function(e){e.preventDefault();m.className='';m.textContent='';
 var p1=document.getElementById('npw').value,p2=document.getElementById('npw2').value;
 if(p1.length<8){m.textContent='Use at least 8 characters.';return;} if(p1!==p2){m.textContent='Passwords do not match.';return;}
 var sb=document.getElementById('sb'); sb.disabled=true; sb.textContent='Saving…';
 fetch(C.url+'/auth/v1/user',{method:'PUT',headers:{apikey:C.key,'Content-Type':'application/json',Authorization:'Bearer '+rec.access_token},body:JSON.stringify({password:p1})})
  .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.msg||j.error_description||'Could not update password.');return j;});})
  .then(function(){store({access_token:rec.access_token,refresh_token:rec.refresh_token,expires_in:rec.expires_in});try{history.replaceState({},'',location.pathname);}catch(e){} sessionStorage.removeItem('gate_refresh_tried');location.reload();})
  .catch(function(err){m.textContent=err.message;sb.disabled=false;sb.textContent='Set new password';});});
if(document.getElementById('email')) document.getElementById('email').focus();
})();
</script></body></html>`;
}

// Edge-generated responses don't receive netlify.toml [[headers]], so the login shell sets its own.
export const SHELL_SECURITY = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const NO_STORE = { 'Cache-Control': 'no-store, private', Vary: 'Cookie, Authorization', 'X-Robots-Tag': 'noindex, nofollow' };

/**
 * @param {Request} request
 * @param {{ env:(k:string)=>string|undefined, fetchImpl:Function, next:()=>Promise<Response>,
 *           title:string, subtitle:string, storageKey:string, requireOperator?:boolean,
 *           signupUrl?:string, manifest?:string, reviewUrl?:string,
 *           canonicalHosts?:Record<string,string> }} deps
 */
export async function handleGate(request, deps) {
  const { env, fetchImpl, next } = deps;
  const moved = canonicalRedirect(request, deps.canonicalHosts);
  if (moved) return moved;
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  let url;
  try { url = new URL(request.url); } catch { url = new URL('https://invalid/'); }

  const supabaseUrl = env('SUPABASE_URL') || '';
  const publicKey = env('SUPABASE_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY') || '';
  const shellHeaders = { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...SHELL_SECURITY };

  if (!supabaseUrl || isPrivilegedKey(publicKey)) {
    return new Response('<!doctype html><title>Unavailable</title><main><h1>Temporarily unavailable</h1><p>Sign-in is not configured.</p></main>',
      { status: 503, headers: shellHeaders });
  }

  const shell = (message, status = 401) => new Response(loginShell({
    title: deps.title, subtitle: deps.subtitle, supabaseUrl, publicKey, storageKey: deps.storageKey,
    allowSignup: String(env('ALLOW_SELF_SIGNUP') || '').toLowerCase() === 'true', signupUrl: deps.signupUrl || '', message,
    manifest: deps.manifest || '/site-aisdr.webmanifest', reviewUrl: deps.reviewUrl || '',
  }), { status, headers: shellHeaders });

  const pageHeaders = { ...shellHeaders, 'Referrer-Policy': 'no-referrer' };
  if (url.pathname === '/auth/handoff') {
    return new Response(handoffPage({ supabaseUrl, publicKey, storageKey: deps.storageKey }), { status: 200, headers: pageHeaders });
  }
  if (url.pathname === '/auth/logout') {
    const h = new Headers(pageHeaders);
    for (const c of clearAuthCookieSetCookieValues(url.hostname, { httpOnly: false })) h.append('Set-Cookie', c);
    return new Response(logoutPage({ next: safeNext(url.searchParams.get('next'), '/') }), { status: 200, headers: h });
  }

  const token = readToken(request);
  if (!token) return shell('');
  const user = await verifyUser(token, { supabaseUrl, publicKey, fetchImpl });
  if (!user) return shell('Your session has expired — please sign in again.');

  if (deps.requireOperator) {
    const ops = operatorSet(env('OPERATOR_EMAILS'));
    const email = String(user.email || '').toLowerCase();
    const confirmed = !!(user.email_confirmed_at || user.confirmed_at);
    if (!confirmed || !ops.has(email)) {
      return shell('This account does not have operator access. Tenant owners can review outreach at Mission Control.', 403);
    }
  }

  const res = await next();
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(NO_STORE)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
