// AG-5 "Operator Dark" + favicon suite guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST = 'site-aisdr.webmanifest';
const SHELLS = ['index.html', 'dashboard/index.html'];
const SKIP = new Set(['node_modules', '.git', 'tests', 'supabase', '.netlify']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|css|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

test('no violet literals or retired --gold/--violet tokens remain (spec §5 regex)', () => {
  const re = /#6e3af5|#5b2fd6|rgba\(110,\s*58,\s*245|var\(--(gold|gold-?2|gold-dim|ydim|violet(-2)?)\)|--(gold|gold-?2|gold-dim|ydim|violet(-2)?)\s*:|#8b5cf6|#a78bfa|#7c3aed|#6d28d9/i;
  const hits = walk(ROOT).filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length));
  assert.deepEqual(hits, []);
});

test('app shells use Operator Dark tokens and the favicon/manifest head tags', () => {
  for (const f of SHELLS) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.match(s, /--surface-canvas:var\(--ink-900\)/, f);
    assert.match(s, /color-scheme:dark/, f);
    assert.match(s, /<link rel="icon" href="\/favicon\.ico"/, f);
    assert.match(s, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml"/, f);
    assert.match(s, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/, f);
    assert.ok(s.includes(`<link rel="manifest" href="/${MANIFEST}"`), f);
    assert.match(s, /<meta name="theme-color" content="#10231d"/, f);
    assert.match(s, /<meta name="robots" content="noindex, nofollow"/, f);
  }
});

test('favicon suite files exist and the manifest parses with its icons', () => {
  for (const f of ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'favicon-32x32.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', MANIFEST]) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
  const m = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
  for (const i of m.icons) assert.ok(existsSync(join(ROOT, i.src.replace(/^\//, ''))), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});

test('netlify.toml serves the webmanifest as application/manifest+json', () => {
  const t = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const re = new RegExp(`for = "/${MANIFEST.replace('.', '\\.')}"\\s*\\n\\s*\\[headers\\.values\\]\\s*\\n\\s*Content-Type = "application/manifest\\+json"`);
  assert.match(t, re);
});

test('gate-core login shell <head> carries the favicon + manifest tags', async () => {
  const { loginShell } = await import('../netlify/edge-lib/gate-core.mjs');
  const html = loginShell({ title: 'T', subtitle: 'S', supabaseUrl: 'https://x.supabase.co', publicKey: 'sb_publishable_x', storageKey: 'k' });
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
  assert.match(head, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml">/);
  assert.match(head, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/);
  assert.ok(head.includes(`<link rel="manifest" href="/${MANIFEST}">`));
  assert.match(head, /<meta name="theme-color" content="#10231d">/);
});
