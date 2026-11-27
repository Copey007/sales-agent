// Phase 1B: AskArlen umbrella header, Arlen mark, and login-shell tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginShell } from '../netlify/edge-lib/gate-core.mjs';

const ROOT = new URL('..', import.meta.url);
const r = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const MARK_RE = /viewBox="0 0 32 32"[\s\S]*?rx="8" fill="#c8f04a"[\s\S]*?d="M9 23L23 9M23 9h-9M23 9v9" stroke="#10231d" stroke-width="3"/;
const RETIRED = /#c8b48c|#6e3af5|Orbitron|Rajdhani/i;
const TOKENS = ['#10231d', '#0e6b54', '#c8f04a', '#f3f4f0'];

function extractScript(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m && m[1], 'login shell must include a script block');
  return m[1];
}

function loginHtml() {
  return loginShell({
    title: 'T', subtitle: 'S', supabaseUrl: 'https://x.supabase.co',
    publicKey: 'sb_publishable_x', storageKey: 'k',
  });
}

test('loginShell uses canonical AskArlen tokens, Arlen mark, and dark forest chrome', () => {
  const html = loginHtml();
  for (const tok of TOKENS) assert.ok(html.includes(tok), tok);
  assert.match(html, MARK_RE);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /<meta name="theme-color" content="#10231d">/);
  assert.match(html, /font-family:var\(--font-sans\)/);
  assert.match(html, /"Plus Jakarta Sans"/);
  assert.match(html, />AskArlen<\/span>/);
  assert.doesNotMatch(html, RETIRED);
  assert.doesNotMatch(html, /font-family:Inter|font:600 \.95rem\/1\.2 Inter,/);
});

test('loginShell extracted <script> passes node --check (exit 0) and keeps SSO cookie helpers', () => {
  const script = extractScript(loginHtml());
  assert.doesNotThrow(() => new Function(script));
  const dir = mkdtempSync(join(tmpdir(), 'login-shell-1b-'));
  const file = join(dir, 'login-shell.js');
  writeFileSync(file, script);
  const checked = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(script, /Domain=\.a-gent\.co/);
  assert.match(script, /writeCookie\('agent_rt'/);
  assert.match(script, /clearAuthCookies/);
  assert.match(script, /Forgot password|forgotF/);
});

test('canonical Arlen mark ships as icon.svg and /assets/arlen-mark.svg', () => {
  for (const f of ['icon.svg', 'assets/arlen-mark.svg']) {
    const s = r(f);
    assert.match(s, MARK_RE, f);
    assert.match(s, /<title>AskArlen<\/title>/, f);
    assert.doesNotMatch(s, /Ask Arlen/, f);
    assert.doesNotMatch(s, RETIRED, f);
  }
});

test('aligned AISDR header/topbar and auth-gate retire gold/violet/Orbitron/Rajdhani', () => {
  const surfaces = [
    ['index.html', r('index.html')],
    ['dashboard/index.html', r('dashboard/index.html')],
    ['auth-gate.js', r('auth-gate.js')],
  ];
  for (const [name, s] of surfaces) {
    if (name.endsWith('.html')) {
      const css = /<style id="askarlen-umbrella-header">([\s\S]*?)<\/style>/.exec(s);
      assert.ok(css, name);
      for (const tok of ['#10231d', '#c8f04a', '#0e6b54']) assert.ok(css[1].includes(tok), `${name} ${tok}`);
      assert.doesNotMatch(css[1], RETIRED, name);
      const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(s);
      assert.ok(header, name);
      assert.match(header[0], /arlen-mark\.svg/, name);
      assert.match(header[0], /AskArlen/, name);
      assert.doesNotMatch(header[0], RETIRED, name);
    } else {
      assert.match(s, /#c8f04a/);
      assert.match(s, /#10231d|#16302a|rgba\(16,35,29/);
      assert.match(s, /Plus Jakarta Sans/);
      assert.doesNotMatch(s, RETIRED, name);
      assert.doesNotMatch(s, /font-family:Inter|font:12px Inter/);
    }
  }
  // Module switcher between AISDR and Mission Control is intact.
  assert.match(r('index.html'), /href="https:\/\/missioncontrol\.a-gent\.co"/);
  assert.match(r('dashboard/index.html'), /<a class="nav-btn" href="https:\/\/missioncontrol\.a-gent\.co"/);
});
