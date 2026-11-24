// Hunter enrollment policy. Tests never call the live Hunter API.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hunterResultAcceptable, hunterAllowRisky, RISKY_HUNTER_STATUSES,
} from '../netlify/functions/_hunter-policy.mjs';

function withFlag(value, fn) {
  const saved = process.env.HUNTER_ALLOW_RISKY;
  if (value === undefined) delete process.env.HUNTER_ALLOW_RISKY;
  else process.env.HUNTER_ALLOW_RISKY = value;
  try { return fn(); }
  finally {
    if (saved === undefined) delete process.env.HUNTER_ALLOW_RISKY;
    else process.env.HUNTER_ALLOW_RISKY = saved;
  }
}

test('default policy accepts valid and high-score webmail only', () => {
  withFlag(undefined, () => {
    assert.equal(hunterAllowRisky(), false);
    assert.equal(hunterResultAcceptable('valid', 90), true);
    assert.equal(hunterResultAcceptable('webmail', 51), true);
    assert.equal(hunterResultAcceptable('webmail', 50), false);
    assert.equal(hunterResultAcceptable('accept_all', 99), false);
    assert.equal(hunterResultAcceptable('unknown', 99), false);
    assert.equal(hunterResultAcceptable('disposable', 99), false);
    assert.equal(hunterResultAcceptable('invalid', 99), false);
    assert.equal(hunterResultAcceptable('', 99), false);
    assert.equal(hunterResultAcceptable(null, 99), false);
  });
});

test('HUNTER_ALLOW_RISKY=true re-allows catch-all only', () => {
  withFlag('true', () => {
    assert.equal(hunterAllowRisky(), true);
    assert.equal(hunterResultAcceptable('accept_all', 10), true);
    assert.equal(hunterResultAcceptable('unknown', 99), false);
    assert.equal(hunterResultAcceptable('disposable', 99), false);
    assert.equal(hunterResultAcceptable('valid', 10), true);
  });
});

test('RISKY_HUNTER_STATUSES lists catch-all, unknown and disposable', () => {
  assert.deepEqual([...RISKY_HUNTER_STATUSES].sort(), ['accept_all', 'disposable', 'unknown'].sort());
});

const ENROLLMENT = [
  'netlify/functions/researcher-background.mjs',
  'netlify/functions/campaign-orchestrator.mjs',
];

test('both enrollment paths use hunterResultAcceptable and no longer special-case accept_all', () => {
  for (const rel of ENROLLMENT) {
    const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    assert.match(src, /hunterResultAcceptable/, rel);
    assert.equal(/status === 'accept_all'|status === "accept_all"/.test(src), false, rel);
    // Orchestrator must not keep the loose "any score > 50" bypass.
    assert.equal(/status === 'valid' \|\| status === 'accept_all' \|\| score > 50/.test(src), false, rel);
  }
});

test('docs/hunter-verification.md documents the default and the flag', () => {
  const docs = readFileSync(new URL('../docs/hunter-verification.md', import.meta.url), 'utf8');
  assert.match(docs, /HUNTER_ALLOW_RISKY/);
  assert.match(docs, /accept_all/);
  assert.match(docs, /unknown/);
  assert.match(docs, /disposable/);
  assert.match(docs, /behaviour change/i);
});
