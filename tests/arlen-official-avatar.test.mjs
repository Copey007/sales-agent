// Official Arlen face + HeyGen look/voice (M1). Tests are local/mocked only —
// no live HeyGen, LiveAvatar, /api/avatar-session, or /api/avatar-chat calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_CONCIERGE_PERSONAS,
  ARLEN_HEYGEN_GROUP_ID,
  ARLEN_HEYGEN_LOOK_ID,
  ARLEN_HEYGEN_VOICE_ID,
  ARLEN_AVATAR_IMAGE,
  getBuiltinPersona,
} from '../netlify/functions/_concierge-personas.mjs';
import { loginShell } from '../netlify/edge-lib/gate-core.mjs';

const GROUP = '7d452e5eac68c6fa8652ac11f117df14';
const LOOK = 'b6e37cc7fa161f33efacf7f4d387977a';
const VOICE = 'ea494dd978f84a7abcd1e7ec5b45b025';
const KATYA_LOOK = '65cca4cf-b7c8-4619-871f-84e2cf8b21d4';
const KATYA_VOICE = '864a26b8-bfba-4435-9cc5-1dd593de5ca7';
const r = (f) => readFileSync(new URL('../' + f, import.meta.url));
const rs = (f) => r(f).toString('utf8');

function webpSize(buf) {
  // VP8X/VP8L/VP8 little-endian width/height from a simple WEBP.
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h };
  }
  if (fourcc === 'VP8 ') {
    // lossy bitstream starts at offset 20; width/height at +26 as 14-bit
    const start = 20;
    const w = buf[start + 6] | ((buf[start + 7] & 0x3f) << 8);
    const h = buf[start + 8] | ((buf[start + 9] & 0x3f) << 8);
    return { w, h };
  }
  throw new Error('unsupported webp fourcc ' + fourcc);
}

test('arlen and askarlen personas carry the official HeyGen group, look, and voice IDs', () => {
  assert.equal(ARLEN_HEYGEN_GROUP_ID, GROUP);
  assert.equal(ARLEN_HEYGEN_LOOK_ID, LOOK);
  assert.equal(ARLEN_HEYGEN_VOICE_ID, VOICE);
  assert.equal(ARLEN_AVATAR_IMAGE, '/assets/arlen-avatar.webp');
  for (const slug of ['arlen', 'askarlen']) {
    const p = getBuiltinPersona(slug);
    assert.equal(p.heygenGroupId, GROUP, slug);
    assert.equal(p.heygenLookId, LOOK, slug);
    assert.equal(p.heygenVoiceId, VOICE, slug);
    assert.equal(p.avatarImage, '/assets/arlen-avatar.webp', slug);
    assert.equal(p.name, 'Arlen');
    assert.equal(p.brand, 'AskArlen');
  }
  assert.equal(BUILTIN_CONCIERGE_PERSONAS.arlen.heygenLookId, LOOK);
});

test('optimized face-centered Arlen webp avatars exist at 512 and 256', () => {
  const files = [
    ['assets/arlen-avatar.webp', 512, 4_000, 80_000],
    ['assets/arlen-avatar-256.webp', 256, 1_500, 40_000],
  ];
  for (const [rel, dim, minB, maxB] of files) {
    const url = new URL('../' + rel, import.meta.url);
    assert.ok(existsSync(url), rel);
    const buf = r(rel);
    const { w, h } = webpSize(buf);
    assert.equal(w, dim, rel + ' width');
    assert.equal(h, dim, rel + ' height');
    const bytes = statSync(url).size;
    assert.ok(bytes >= minB && bytes <= maxB, `${rel} size ${bytes}`);
  }
  // Lime-tile ↗ brand mark is unchanged and distinct from the face crop.
  const mark = rs('assets/arlen-mark.svg');
  assert.match(mark, /fill="#c8f04a"/);
  assert.match(mark, /d="M9 23L23 9M23 9h-9M23 9v9"/);
  assert.doesNotMatch(mark, /arlen-avatar/);
});

test('AskArlen concierge chrome uses the face crop as the avatar and keeps the lime-tile mark as the logo', () => {
  const html = rs('concierge.html');
  assert.match(html, /assets\/arlen-avatar\.webp/);
  assert.match(html, /assets\/arlen-mark\.svg/);
  assert.match(html, /slug === 'arlen' \|\| slug === 'askarlen'/);
  // Brand mark is the logo; the face is the header avatar, not the favicon.
  assert.doesNotMatch(html, /headerLogo[\s\S]{0,80}arlen-avatar\.webp/);
  assert.match(html, /headerAvatar[\s\S]{0,120}arlen-avatar\.webp/);
  assert.match(html, /slug: slug \|\| undefined/);
});

test('Katya remains scoped to existing A-Gent starter/demo defaults and is not replaced by Arlen IDs', () => {
  const signup = rs('netlify/functions/signup.mjs');
  const schema = rs('netlify/functions/avatar-schema.sql');
  assert.match(signup, new RegExp(KATYA_VOICE));
  assert.match(schema, new RegExp(KATYA_LOOK));
  assert.match(schema, new RegExp(KATYA_VOICE));
  for (const [name, src] of [['signup.mjs', signup], ['avatar-schema.sql', schema]]) {
    assert.doesNotMatch(src, new RegExp(LOOK), name);
    assert.doesNotMatch(src, new RegExp(VOICE), name);
    assert.doesNotMatch(src, new RegExp(GROUP), name);
  }
  const extPopup = rs('extension/popup.js');
  const extBg = rs('extension/background.js');
  for (const [name, src] of [['popup.js', extPopup], ['background.js', extBg]]) {
    assert.doesNotMatch(src, new RegExp(LOOK), name);
    assert.doesNotMatch(src, new RegExp(VOICE), name);
    assert.doesNotMatch(src, new RegExp(GROUP), name);
  }
});

test('persona module and official-avatar tests never call HeyGen or live avatar APIs', () => {
  const persona = rs('netlify/functions/_concierge-personas.mjs');
  assert.doesNotMatch(persona, /api\.heygen\.com|api\.liveavatar\.com|\/api\/avatar-session|\/api\/avatar-chat/);
  assert.doesNotMatch(persona, /\bfetch\s*\(/);
  const self = rs('tests/arlen-official-avatar.test.mjs');
  assert.doesNotMatch(self, /api\.heygen\.com|api\.liveavatar\.com/);
});

test('loginShell extracted <script> still passes node --check (exit 0)', async () => {
  const html = loginShell({
    title: 'T', subtitle: 'S', supabaseUrl: 'https://x.supabase.co',
    publicKey: 'sb_publishable_x', storageKey: 'k',
  });
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m && m[1]);
  const dir = mkdtempSync(join(tmpdir(), 'login-shell-m1-'));
  const file = join(dir, 'login-shell.js');
  writeFileSync(file, m[1]);
  const checked = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(m[1], /Domain=\.a-gent\.co/);
  assert.match(m[1], /clearAuthCookies/);
});
