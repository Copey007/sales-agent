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

export function loginShell({ title, subtitle, supabaseUrl, publicKey, storageKey, allowSignup = false, signupUrl = '', message = '', manifest = '/site-aisdr.webmanifest', reviewUrl = '' }) {
  const cfg = JSON.stringify({ url: supabaseUrl.replace(/\/$/, ''), key: publicKey, storageKey, cookie: COOKIE })
    .replace(/</g, '\\u003c');
  const review = reviewUrl ? `<div class="alt"><a href="${esc(reviewUrl)}">Review outreach in Mission Control</a></div>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="${esc(manifest)}"><meta name="theme-color" content="#0a0a0c">
<title>Sign in · ${esc(title)}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,-apple-system,sans-serif;background:#0a0a0c;color:#f0f0f2}
main{width:min(380px,calc(100% - 32px));background:#131316;border:1px solid #2a2a30;border-radius:16px;padding:28px}
h1{margin:0 0 6px;font-size:1.3rem}p{margin:0 0 18px;color:#a1a1a6;font-size:.9rem}
label{display:block;font-size:.8rem;color:#a1a1a6;margin:0 0 4px}
input{width:100%;margin:0 0 14px;padding:10px 12px;border-radius:10px;border:1px solid #6b6b70;background:#0a0a0c;color:#f0f0f2;font:inherit}
input:hover{border-color:#8a8a90}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid #c8b48c;outline-offset:2px}
button{width:100%;padding:11px;border:0;border-radius:10px;background:#c8b48c;color:#0a0a0c;font:600 .95rem/1.2 Inter,system-ui,-apple-system,sans-serif;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}#msg{min-height:1.2em;margin:12px 0 0;color:#d4625a;font-size:.85rem}
a{color:#c8b48c}.alt{margin-top:14px;text-align:center;font-size:.85rem}
.hid{display:none}#msg.ok{color:#8fd9a8}
</style></head>
<body><main aria-labelledby="t"><h1 id="t">${esc(title)}</h1><p>${esc(subtitle)}</p>
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
function setCookie(t,maxAge){document.cookie=C.cookie+'='+encodeURIComponent(t)+'; Path=/; Max-Age='+Math.max(0,maxAge|0)+'; Secure; SameSite=Lax';}
function store(d,email){var s={access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),email:email||(d.user&&d.user.email)||''};
 try{localStorage.setItem(C.storageKey,JSON.stringify(s));}catch(e){} setCookie(s.access_token,s.expires_at-Math.floor(Date.now()/1000));}
function grant(type,body){return fetch(C.url+'/auth/v1/token?grant_type='+type,{method:'POST',headers:{apikey:C.key,'Content-Type':'application/json'},body:JSON.stringify(body)})
 .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error_description||j.msg||'Invalid email or password.');return j;});});}
function pick(h,q,k){return h.get(k)||q.get(k)||'';}
function cb(){var h=new URLSearchParams((location.hash||'').replace(/^#/,''));var q=new URLSearchParams((location.search||'').replace(/^\?/,''));return{type:pick(h,q,'type'),access_token:pick(h,q,'access_token'),refresh_token:pick(h,q,'refresh_token'),expires_in:Number(pick(h,q,'expires_in')||0)||3600,error:pick(h,q,'error_description')||pick(h,q,'error')};}
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
   if(s&&s.refresh_token&&!sessionStorage.getItem('gate_refresh_tried')){sessionStorage.setItem('gate_refresh_tried','1');
    grant('refresh_token',{refresh_token:s.refresh_token}).then(function(d){store(d,s.email);location.reload();},function(){try{localStorage.removeItem(C.storageKey);}catch(e){}});}}catch(e){}
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
 *           signupUrl?:string, manifest?:string, reviewUrl?:string }} deps
 */
export async function handleGate(request, deps) {
  const { env, fetchImpl, next } = deps;
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();

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
