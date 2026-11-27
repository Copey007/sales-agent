// Dashboard header: logo resolves to a real file; header links are styled pills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const s = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
test('dashboard logo <img> points at an existing absolute asset', () => {
  const src = /<div class="brand">.*?<img src="([^"]+)"/s.exec(s)[1];
  assert.ok(src.startsWith('/'), src);
  assert.ok(existsSync(new URL('..' + src, import.meta.url)), src);
});
test('header .nav-btn links share the pill base style and point at missioncontrol', () => {
  assert.match(s, /\.pill,\.button,\.sig-btn,\.nav-btn\{/);
  assert.match(s, /<a class="nav-btn" href="https:\/\/missioncontrol\.askarlen\.com\/"/);
});
