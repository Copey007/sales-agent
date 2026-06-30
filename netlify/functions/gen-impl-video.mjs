/**
 * One-shot HeyGen video generator for the Implementation Agent walkthrough.
 *
 * POST /api/gen-impl-video   (Authorization: Bearer <jwt>)
 *   { script?, avatar_id?, voice_id? }   → { video_id }   (starts the render)
 * GET  /api/gen-impl-video?video_id=...  (Authorization: Bearer <jwt>)
 *                                        → { status, url } (poll until completed)
 *
 * Uses the HeyGen Video Generation API (api.heygen.com/v2/video/generate) with the
 * platform HeyGen/LiveAvatar key. JWT-guarded so it can't be spammed (costs money).
 * NOTE: the avatar_id we use is a LiveAvatar (streaming) id; if HeyGen's video API
 * rejects it, the error is surfaced so we know it's studio-only.
 */

import { userFromToken } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const DEFAULT_AVATAR = '26393b8e-e944-4367-98ef-e2bc75c4b792';
const DEFAULT_VOICE = '864a26b8-bfba-4435-9cc5-1dd593de5ca7';
const DEFAULT_SCRIPT = `Welcome aboard — and congratulations on signing your contract. I'm your implementation guide, and I'll walk you through getting set up, step by step.

Here's how the next few minutes will go. First, we'll give your agent its voice — your company's persona and the key things it should know about your product. Second, we'll add your demo material, so your agent can show, not just tell — slides, screenshots, even recorded demo clips that play on cue. And third, we'll put your agent on your site, or hand you a shareable link, so it greets and guides your customers around the clock.

The best part? You're not doing this alone. I'm right here inside Mission Control whenever you need me — ask me anything, and I'll walk you through it or show you exactly how it works.

So — ready? Let's build your agent.`;

const KEY = () => process.env.HEYGEN_API_KEY || process.env.LIVEAVATAR_API_KEY;

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  const key = KEY();
  if (!key) return json({ error: 'No HeyGen key (HEYGEN_API_KEY / LIVEAVATAR_API_KEY)' }, 500);
  const hg = (path, init = {}) => fetch(`https://api.heygen.com${path}`, { ...init, headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  // ── List avatars / voices (to find video-API-compatible ids) ─────────────────
  if (req.method === 'GET' && new URL(req.url).searchParams.get('list')) {
    const what = new URL(req.url).searchParams.get('list');
    if (what === 'voices') {
      const res = await hg('/v2/voices');
      const data = await res.json().catch(() => ({}));
      const voices = (data?.data?.voices || []).map(v => ({ id: v.voice_id, name: v.name, gender: v.gender, lang: v.language, preview: !!v.preview_audio }));
      return json({ count: voices.length, voices: voices.slice(0, 400) });
    }
    const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase();
    const res = await hg('/v2/avatars');
    if (!res.ok) return json({ error: `avatars ${res.status}`, body: (await res.text()).slice(0, 300) }, 502);
    const data = await res.json().catch(() => ({}));
    let avatars = (data?.data?.avatars || []).map(a => ({ id: a.avatar_id, name: a.avatar_name, gender: a.gender }));
    if (q) avatars = avatars.filter(a => (a.name || '').toLowerCase().includes(q) || (a.gender || '').toLowerCase() === q);
    return json({ total: (data?.data?.avatars || []).length, count: avatars.length, avatars: avatars.slice(0, 60) });
  }

  // ── Poll status ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('video_id');
    if (!id) return json({ error: 'video_id required' }, 400);
    const res = await hg(`/v1/video_status.get?video_id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data?.error || `status ${res.status}`, raw: data }, 502);
    const d = data.data || {};
    return json({ status: d.status, url: d.video_url || null, error: d.error || null });
  }

  // ── Re-host a (temporary) video URL into permanent Supabase Storage ──────────
  let b = {}; try { b = await req.json(); } catch {}
  if (b.rehost) {
    const SUPA = process.env.SUPABASE_URL, SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPA || !SKEY) return json({ error: 'Supabase not configured' }, 500);
    const sHead = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };
    const src = await fetch(b.rehost);
    if (!src.ok) return json({ error: `fetch source ${src.status}` }, 502);
    const bytes = new Uint8Array(await src.arrayBuffer());
    const path = `impl/${(b.name || 'implementation-agent')}.mp4`;
    await fetch(`${SUPA}/storage/v1/bucket`, { method: 'POST', headers: { ...sHead, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'slides', name: 'slides', public: true }) }).catch(() => {});
    const up = await fetch(`${SUPA}/storage/v1/object/slides/${path}`, { method: 'POST', headers: { ...sHead, 'Content-Type': 'video/mp4', 'x-upsert': 'true' }, body: bytes });
    if (!up.ok) return json({ error: `upload ${up.status}: ${(await up.text()).slice(0, 200)}` }, 502);
    return json({ url: `${SUPA}/storage/v1/object/public/slides/${path}`, bytes: bytes.length });
  }

  // ── Attach a video as demo material on an agent (service-role; prepends a slide) ─
  if (b.attach) {
    const SUPA = process.env.SUPABASE_URL, SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sHead = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
    const gr = await fetch(`${SUPA}/rest/v1/avatar_agents?slug=eq.${encodeURIComponent(b.attach)}&select=slides&limit=1`, { headers: sHead });
    const rows = await gr.json().catch(() => []);
    if (!rows.length) return json({ error: `agent ${b.attach} not found` }, 404);
    const slides = Array.isArray(rows[0].slides) ? rows[0].slides : [];
    slides.unshift({ id: 's' + Math.random().toString(36).slice(2, 10), title: b.title || 'Implementation walkthrough', url: b.video_url, triggers: b.triggers || ['walk me through setup', 'get started', 'guided walkthrough', 'onboarding'], narration: '' });
    const patch = { slides };
    if (b.greeting) patch.greeting = b.greeting;
    const pr = await fetch(`${SUPA}/rest/v1/avatar_agents?slug=eq.${encodeURIComponent(b.attach)}`, { method: 'PATCH', headers: { ...sHead, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    if (!pr.ok) return json({ error: `patch ${pr.status}: ${(await pr.text()).slice(0, 200)}` }, 502);
    return json({ ok: true, slides: slides.length });
  }

  const script = (b.script || DEFAULT_SCRIPT).trim();
  const avatar_id = b.avatar_id || DEFAULT_AVATAR;
  const voice_id = b.voice_id || DEFAULT_VOICE;

  const body = {
    video_inputs: [{
      character: { type: 'avatar', avatar_id, avatar_style: 'normal' },
      voice: { type: 'text', input_text: script, voice_id },
    }],
    dimension: { width: 1280, height: 720 },
  };

  const res = await hg('/v2/video/generate', { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data?.error || data?.message || `generate ${res.status}`, raw: data }, 502);
  return json({ video_id: data?.data?.video_id || data?.video_id || null, raw: data });
};

export const config = { path: '/api/gen-impl-video' };
