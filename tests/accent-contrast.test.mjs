// Tenant-accent text colour: WCAG 2.x contrast pick (AG-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickOnAccent, contrastRatio, relativeLuminance, applyTenantAccent, DARK_TEXT, LIGHT_TEXT, DEFAULT_ACCENT } from '../assets/accent-contrast.mjs';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('relative luminance / contrast follow WCAG 2.x (sRGB linearised)', () => {
  close(relativeLuminance('#ffffff'), 1);
  close(relativeLuminance('#000000'), 0);
  close(contrastRatio('#000', '#fff'), 21);
  close(contrastRatio('#8a8a90', '#0a0a0c'), 5.76);   // spec §4 row
  close(contrastRatio('#0a0a0c', '#c8b48c'), 9.76);   // spec §4 row
});

test('dark tenant accent #1a2b4c gets light text (≥ 4.5:1)', () => {
  const r = pickOnAccent('#1a2b4c');
  assert.equal(r.fallback, false);
  assert.equal(r.accent, '#1a2b4c');
  assert.equal(r.onAccent, LIGHT_TEXT);
  assert.ok(r.ratio >= 4.5, String(r.ratio));
});

for (const mid of ['#4f7cff', '#7a7a7a']) {
  test(`mid-tone accent ${mid} picks the higher-ratio token, ratio ≥ 4.5`, () => {
    const r = pickOnAccent(mid);
    const rd = contrastRatio(DARK_TEXT, mid), rl = contrastRatio(LIGHT_TEXT, mid);
    assert.equal(r.fallback, false);
    assert.equal(r.onAccent, rd >= rl ? DARK_TEXT : LIGHT_TEXT);
    close(r.ratio, Math.max(rd, rl), 1e-9);
    assert.ok(r.ratio >= 4.5, String(r.ratio));
  });
}

test('default gold keeps dark ink text', () => {
  const r = pickOnAccent(DEFAULT_ACCENT);
  assert.deepEqual([r.accent, r.onAccent, r.fallback], ['#c8b48c', DARK_TEXT, false]);
  close(r.ratio, 9.76);
});

test('fallback: no token reaches 4.5:1 (mid grey #777777) or invalid input → default accent + warning', () => {
  assert.ok(contrastRatio(DARK_TEXT, '#777777') < 4.5 && contrastRatio(LIGHT_TEXT, '#777777') < 4.5);
  for (const bad of ['#777777', 'not-a-colour', '', null]) {
    const r = pickOnAccent(bad);
    assert.equal(r.fallback, true, String(bad));
    assert.equal(r.accent, DEFAULT_ACCENT);
    assert.equal(r.onAccent, DARK_TEXT);
    assert.ok(r.ratio >= 4.5);
  }
  const set = {}; const warns = [];
  const el = { style: { setProperty: (k, v) => { set[k] = v; } } };
  applyTenantAccent('#777777', el, (m) => warns.push(m));
  assert.deepEqual(set, { '--accent': DEFAULT_ACCENT, '--on-accent': DARK_TEXT });
  assert.equal(warns.length, 1);
  applyTenantAccent('#1a2b4c', el, (m) => warns.push(m));
  assert.deepEqual(set, { '--accent': '#1a2b4c', '--on-accent': LIGHT_TEXT });
  assert.equal(warns.length, 1);
});

test('agent.html applies tenant accents through applyTenantAccent and uses --on-accent on accent fills', () => {
  const s = readFileSync(new URL('../agent.html', import.meta.url), 'utf8');
  assert.match(s, /import \{ applyTenantAccent \} from '\/assets\/accent-contrast\.mjs'/);
  assert.match(s, /applyTenantAccent\(t\.primary_color\)/);
  assert.equal(/setProperty\('--accent'/.test(s), false);
  assert.equal(/background:var\(--accent\);color:var\(--text-on-accent\)/.test(s), false);
  assert.match(s, /--on-accent:var\(--text-on-accent\)/);
});
