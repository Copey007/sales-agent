// Tenant-accent text colour (AG-5). Pure, dependency-free; used by agent.html.
// Picks whichever text token (dark ink or light ink) has the higher WCAG 2.x
// contrast ratio against the tenant accent. If neither reaches the minimum
// (AA 4.5:1 for normal text), falls back to the default accent.
export const DARK_TEXT = '#0a0a0c';   // --ink-900 / --text-on-accent
export const LIGHT_TEXT = '#f0f0f2';  // --ink-50  / --text-primary
export const DEFAULT_ACCENT = '#c8b48c'; // --gold-400
export const MIN_RATIO = 4.5;

export function parseHex(input) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(input ?? '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// WCAG 2.x relative luminance with sRGB linearisation.
export function relativeLuminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return NaN;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Returns { accent, onAccent, ratio, fallback, reason? }.
export function pickOnAccent(accent, { dark = DARK_TEXT, light = LIGHT_TEXT, fallbackAccent = DEFAULT_ACCENT, min = MIN_RATIO } = {}) {
  const best = (bg) => {
    const rd = contrastRatio(dark, bg), rl = contrastRatio(light, bg);
    return rd >= rl ? { onAccent: dark, ratio: rd } : { onAccent: light, ratio: rl };
  };
  const norm = parseHex(accent) ? `#${String(accent).trim().replace(/^#/, '').toLowerCase()}` : null;
  if (norm) {
    const b = best(norm);
    if (b.ratio >= min) return { accent: norm, ...b, fallback: false };
  }
  const fb = best(fallbackAccent);
  return { accent: fallbackAccent, ...fb, fallback: true, reason: norm ? `no text token reaches ${min}:1 on ${norm}` : `invalid accent ${JSON.stringify(accent)}` };
}

// Browser helper: sets --accent and --on-accent on an element (default <html>).
export function applyTenantAccent(accent, el = globalThis.document?.documentElement, warn = (...a) => console.warn(...a)) {
  const r = pickOnAccent(accent);
  if (r.fallback) warn(`[theme] tenant accent rejected (${r.reason}); using ${r.accent}`);
  if (el) { el.style.setProperty('--accent', r.accent); el.style.setProperty('--on-accent', r.onAccent); }
  return r;
}
