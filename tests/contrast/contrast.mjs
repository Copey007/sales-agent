// Brand review r2 (AG-5): run against a locally served build. Needs playwright-core + Chrome (CHROME_PATH). Not part of npm test.
// Exit summary prints TOTAL_FAILS per state; thresholds: hover text 4.5, input borders 3, input hover borders 3, focus outlines 3, danger text 4.5.
// Computed-style contrast checks axe can't do: hover text, input borders (+hover), focus outlines, danger text on danger bg.
// usage: node contrast.mjs <outJson> <label> <url> <action|0> <session:1|0> [shotPrefix]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { respond } from './mock.mjs';
const [,, outJson, label, url, action, session, shotPrefix] = process.argv;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const all = {};
const LIB = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  window.__rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const [r, g, bb, a] = cx.getImageData(0, 0, 1, 1).data; return [r, g, bb, a / 255]; };
  const lum = ([r, g, bb]) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bb); };
  window.__ratio = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, base) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + base[i] * (1 - a)).concat(1); };
  const gradStops = (img) => (img.match(/(rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/gi) || []);
  // all candidate opaque backgrounds behind el (gradients → every stop)
  window.__bgs = (el) => {
    const chain = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    const sb = getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(); let bases = [sb ? window.__rgba(sb) : [255, 255, 255, 1]];
    for (const n of chain.reverse()) {
      const cs = getComputedStyle(n); const layers = [];
      const img = cs.backgroundImage; if (img && img.includes('gradient')) layers.push(gradStops(img).map(window.__rgba));
      const bg = window.__rgba(cs.backgroundColor);
      const next = []; for (const base of bases) { let cur = bg[3] > 0 ? over(bg, base) : base; if (layers.length) for (const st of layers[0]) next.push(over(st, cur)); else next.push(cur); }
      bases = next.slice(0, 12);
    }
    return bases;
  };
  window.__fg = (el) => { const c = window.__rgba(getComputedStyle(el).color); const bgs = window.__bgs(el); return bgs.map((bg) => window.__ratio(over(c, bg), bg)); };
  window.__vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.2 && (el.textContent.trim() || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); };
  window.__name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')) + ' «' + (el.textContent || el.placeholder || el.name || '').trim().slice(0, 24) + '»';
};
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  if (session === '1') await ctx.addInitScript(() => { const s = JSON.stringify({ access_token: 'fake.local.token', refresh_token: 'x', expires_at: Math.floor(Date.now() / 1000) + 3600, email: 'operator@example.com' }); localStorage.setItem('mc_session', s); localStorage.setItem('agent_auth_session_v1', s); });
  const p = await ctx.newPage();
  await p.route(/supabase\.co|aisdr\.a-gent\.co\/api|localhost:\d+\/api\//, (route, req) => { const r = respond(req.url()); return r ? route.fulfill(r) : route.continue(); });
  await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(1200);
  if (session === '1') await p.evaluate(() => { document.getElementById('agent-auth-gate')?.remove(); document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('agent-auth-gate')) s.remove(); }); const lg = document.getElementById('loginGate'); if (lg) lg.style.display = 'none'; });
  if (action && action !== '0') { await p.evaluate(action); await p.waitForTimeout(1500); }
  await p.addScriptTag({ content: `(${LIB})()` });
  await p.evaluate(() => { document.querySelectorAll('*').forEach((e) => { e.style.transition = 'none'; }); });
  const res = { hover: [], border: [], borderHover: [], focus: [], danger: [] };
  // tag targets
  const n = await p.evaluate(() => {
    const els = [...document.querySelectorAll('button, .brandbtn, a.nav-btn, .scan-btn, .cm-submit, .sig-btn, [role=button], input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea, select')].filter(window.__vis).filter((e) => !e.disabled);
    els.slice(0, 80).forEach((e, i) => e.setAttribute('data-ct', i)); return Math.min(80, els.length);
  });
  for (let i = 0; i < n; i++) {
    const sel = `[data-ct="${i}"]`;
    const isField = await p.$eval(sel, (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)).catch(() => null);
    if (isField === null) continue;
    try { await p.hover(sel, { timeout: 800, force: true }); } catch { continue; }
    await p.waitForTimeout(60);
    if (isField) {
      const r = await p.$eval(sel, (e) => { const c = window.__rgba(getComputedStyle(e).borderTopColor); const bgs = window.__bgs(e.parentElement); return { el: window.__name(e), color: getComputedStyle(e).borderTopColor, ratio: Math.min(...bgs.map((bg) => window.__ratio([0, 1, 2].map((k) => c[k] * c[3] + bg[k] * (1 - c[3])), bg))) }; });
      res.borderHover.push(r);
      await p.mouse.move(0, 0); await p.waitForTimeout(40);
      res.border.push(await p.$eval(sel, (e) => { const c = window.__rgba(getComputedStyle(e).borderTopColor); const bgs = window.__bgs(e.parentElement); return { el: window.__name(e), color: getComputedStyle(e).borderTopColor, ratio: Math.min(...bgs.map((bg) => window.__ratio([0, 1, 2].map((k) => c[k] * c[3] + bg[k] * (1 - c[3])), bg))) }; }));
    } else {
      res.hover.push(await p.$eval(sel, (e) => ({ el: window.__name(e), color: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor, ratio: Math.min(...window.__fg(e)) })));
      await p.mouse.move(0, 0);
    }
    // focus-visible: keyboard modality then programmatic focus
    await p.keyboard.press('Shift');
    await p.$eval(sel, (e) => e.focus());
    { const fr = await p.$eval(sel, (e) => { const cs = getComputedStyle(e); const fv = e.matches(':focus-visible'); if (document.activeElement !== e) return { el: window.__name(e), skipped: 'not focusable in this state' }; const c = window.__rgba(cs.outlineColor); const bgs = window.__bgs(e.parentElement); const ok = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2; return { el: window.__name(e), focusVisible: fv, outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, ratio: ok ? Math.min(...bgs.map((bg) => window.__ratio(c, bg))) : 0 }; }); if (fr.skipped) res.focusSkipped = (res.focusSkipped || 0) + 1; else res.focus.push(fr); }
    await p.$eval(sel, (e) => e.blur());
  }
  // danger text on danger backgrounds (notices/badges), including an injected notice in every panel type
  res.danger = await p.evaluate(() => {
    const out = [];
    const hosts = [document.body, ...document.querySelectorAll('.panel, .card, .modal-panel, .drill-stat, .empty-step-note, .preview-subject, .table-wrap')].filter((h) => h.getBoundingClientRect().width > 0).slice(0, 15);
    for (const h of hosts) { const d = document.createElement('div'); d.className = 'notice err'; d.textContent = 'Example error'; d.setAttribute('data-probe', '1'); h.appendChild(d); }
    for (const e of document.querySelectorAll('.notice.err, .badge.red')) { if (!e.getBoundingClientRect().width) continue; out.push({ el: window.__name(e) + (e.dataset.probe ? ' (probe in ' + window.__name(e.parentElement) + ')' : ''), ratio: Math.min(...window.__fg(e)) }); }
    document.querySelectorAll('[data-probe]').forEach((e) => e.remove());
    return out;
  });
  if (shotPrefix) {
    // hover screenshot of first primary-ish button + input border screenshot
    const prim = await p.$('.brandbtn.primary:visible, #loginBtn:visible, .cm-submit:not([disabled]):visible, button[type=submit]:visible, .sig-btn:visible');
    if (prim && await prim.isVisible()) { await prim.scrollIntoViewIfNeeded(); await prim.hover({ force: true }); await p.waitForTimeout(150); await p.screenshot({ path: `${shotPrefix}-hover-${w}-r2.png` }); }
    const field = await p.$('input:visible, textarea:visible');
    if (field) { await field.scrollIntoViewIfNeeded(); await p.mouse.move(0, 0); await p.screenshot({ path: `${shotPrefix}-inputs-${w}-r2.png` }); }
  }
  all[w] = res; await ctx.close();
}
await b.close();
writeFileSync(outJson, JSON.stringify(all, null, 1));
let fails = 0; const lines = [];
for (const [w, r] of Object.entries(all)) {
  const chk = (k, min) => { const v = r[k]; const bad = v.filter((x) => !(x.ratio >= min)); fails += bad.length; const mn = v.length ? Math.min(...v.map((x) => x.ratio)).toFixed(2) : '—'; lines.push(`${label} ${w} ${k}: n=${v.length} min=${mn} fail=${bad.length}` + (bad.length ? ' ← ' + bad.slice(0, 4).map((x) => `${x.el} ${x.ratio.toFixed(2)}${x.outline ? ' [' + x.outline + ']' : ''}${x.color ? ' [' + x.color + ']' : ''}`).join(' | ') : '')); };
  chk('hover', 4.5); chk('border', 3); chk('borderHover', 3); chk('focus', 3); chk('danger', 4.5);
}
console.log(lines.join('\n')); console.log(`${label} TOTAL_FAILS=${fails}`);
