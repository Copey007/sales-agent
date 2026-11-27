// Web Designer brand review r2 (AG-5) + token-and-contrast-spec sha 4ed34f84.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const pages = ['index.html', 'dashboard/index.html', 'agent.html'];

test('spec tokens: --border-input #6b6b70, alias, hover #8a8a90, danger-bg 8%', () => {
  for (const f of pages) {
    const s = r(f);
    assert.match(s, /--border-input:#6b6b70;/, f);
    assert.match(s, /--border-input-hover:#8a8a90;/, f);
    assert.match(s, /--input-border:var\(--border-input\)/, f);
    assert.match(s, /--status-danger-bg:color-mix\(in srgb, var\(--red-400\) 8%, transparent\)/, f);
    assert.doesNotMatch(s, /--status-danger-bg:[^;]*12%/, f);
  }
});
test('blockers: brandbtn primary hover + modal backdrop', () => {
  const s = r('index.html');
  assert.match(s, /\.brandbtn\.primary:hover\{background:var\(--accent-strong\)\}/);
  assert.match(s, /\.modal\{background:rgba\(0,0,0,\.72\)\}/);
  assert.doesNotMatch(s, /\.modal\{background:rgba\(255,255,255/);
});
test('dashboard: no Orbitron, no #fff4c4-family literals, active titles use accent-text', () => {
  const s = r('dashboard/index.html');
  assert.doesNotMatch(s, /Orbitron/);
  assert.doesNotMatch(s, /#fff4c4|#fff4bd|#fff2bc|#fff7d6/i);
  assert.match(s, /\.workspace-tab\.active strong\{color:var\(--accent-text\)\}/);
  assert.match(s, /\.intel-tab\.active\{color:var\(--accent-text\)/);
});
test('loop engine canvas uses brand colours only', () => {
  for (const f of ['index.html', 'dashboard/index.html']) {
    const s = r(f);
    assert.doesNotMatch(s, /#d7a72f|#ff5c7a|rgba\(14,\s*143,\s*111|rgba\(255,\s*92,\s*122/i, f);
  }
});
test('danger notices/badges carry their own opaque background (never sit on sunken)', () => {
  for (const f of ['index.html', 'dashboard/index.html']) {
    const s = r(f);
    assert.match(s, /\.notice\.err\{[^}]*background:color-mix\(in srgb, var\(--status-danger\) 8%, var\(--surface-raised\)\)/, f);
    assert.match(s, /\.badge\.red\{[^}]*background:color-mix\(in srgb, var\(--status-danger\) 8%, var\(--surface-raised\)\)/, f);
  }
});
test('nits: gate font shorthand valid, popup dot on palette, no off-scale #fff/#d6d9e4 in daylight block', () => {
  const g = r('netlify/edge-lib/gate-core.mjs');
  assert.doesNotMatch(g, /font:600 \.95rem inherit/);
  assert.match(g, /font:600 \.95rem\/1\.2 "Plus Jakarta Sans",/);
  assert.doesNotMatch(r('extension/popup.html'), /#6366f1/i);
  const s = r('index.html');
  assert.doesNotMatch(s, /\.topbar \.title\{color:#fff;/);
  assert.doesNotMatch(s, /\.brandbtn\{[^}]*#d6d9e4/);
});
test('auth-gate: Inter + focus-visible ring', () => {
  const s = r('auth-gate.js');
  assert.doesNotMatch(s, /font-family:system-ui|font:12px system-ui/);
  assert.match(s, /#agent-auth-gate :focus-visible\{outline:2px solid #c8f04a;outline-offset:2px\}/);
  assert.match(s, /#agent-auth-gate input:hover\{border-color:#8a8a90 !important\}/);
  assert.match(r('netlify/edge-lib/gate-core.mjs'), /input:hover\{border-color:#8a8a90\}/);
});
