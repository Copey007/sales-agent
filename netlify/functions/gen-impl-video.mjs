/**
 * One-shot HeyGen video generator for the Implementation Agent walkthrough.
 *
 * POST /api/gen-impl-video   (Authorization: Bearer <jwt>)
 *   { script?, avatar_id?, voice_id? }   → { video_id }   (starts the render)
 * GET  /api/gen-impl-video?video_id=...  (Authorization: Bearer <jwt>)
 *                                        → { status, url } (poll until completed)
 *
 * Uses the HeyGen V3 Video API (api.heygen.com/v3/videos) with the platform
 * HeyGen/LiveAvatar key. V1/V2 endpoints sunset October 31, 2026.
 * JWT-guarded so it can't be spammed (costs money).
 * NOTE: avatar_id must be a V3 look id (see ?list=avatars); LiveAvatar streaming
 * ids are a different product and are rejected by this API.
 */

import { userFromToken } from './_tenant.mjs';
import { withCors } from './_auth.mjs';
import { operatorGuard } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const DEFAULT_AVATAR = 'b6132b8df299488d8e886d471dc424ba'; // "Professional Presenter" V3 look id (private photo avatar)
const DEFAULT_VOICE = ''; // empty → V3 uses the look's default voice
const DEFAULT_SCRIPT = `Welcome aboard — and congratulations on signing your contract. I'm your implementation guide, and I'll walk you through getting set up, step by step.

Here's how the next few minutes will go. First, we'll give your agent its voice — your company's persona and the key things it should know about your product. Second, we'll add your demo material, so your agent can show, not just tell — slides, screenshots, even recorded demo clips that play on cue. And third, we'll put your agent on your site, or hand you a shareable link, so it greets and guides your customers around the clock.

The best part? You're not doing this alone. I'm right here inside Mission Control whenever you need me — ask me anything, and I'll walk you through it or show you exactly how it works.

So — ready? Let's build your agent.`;

const KEY = () => process.env.HEYGEN_API_KEY || process.env.LIVEAVATAR_API_KEY;

const __handler = async (req) => {
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
      const voices = [];
      let token = '';
      do {
        const res = await hg(`/v3/voices?limit=100${token ? `&token=${encodeURIComponent(token)}` : ''}`);
        if (!res.ok) return json({ error: `voices ${res.status}`, body: (await res.text()).slice(0, 300) }, 502);
        const data = await res.json().catch(() => ({}));
        for (const v of data?.data || []) voices.push({ id: v.voice_id, name: v.name, gender: v.gender, lang: v.language, preview: !!v.preview_audio_url });
        token = data?.has_more ? (data?.next_token || '') : '';
      } while (token && voices.length < 400);
      return json({ count: voices.length, voices: voices.slice(0, 400) });
    }
    const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase();
    const all = [];
    let token = '';
    do {
      const res = await hg(`/v3/avatars/looks?limit=50${token ? `&token=${encodeURIComponent(token)}` : ''}`);
      if (!res.ok) return json({ error: `avatars ${res.status}`, body: (await res.text()).slice(0, 300) }, 502);
      const data = await res.json().catch(() => ({}));
      for (const a of data?.data || []) all.push({ id: a.id, name: a.name, gender: a.gender, engines: a.supported_api_engines || [] });
      token = data?.has_more ? (data?.next_token || '') : '';
    } while (token && all.length < 300);
    let avatars = all;
    if (q) avatars = avatars.filter(a => (a.name || '').toLowerCase().includes(q) || (a.gender || '').toLowerCase() === q);
    return json({ total: all.length, count: avatars.length, avatars: avatars.slice(0, 60) });
  }

  // ── Poll status ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('video_id');
    if (!id) return json({ error: 'video_id required' }, 400);
    const res = await hg(`/v3/videos/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data?.error || `status ${res.status}`, raw: data }, 502);
    const d = data.data || {};
    return json({ status: d.status, url: d.video_url || null, error: d.failure_message || null });
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
    type: 'avatar',
    title: b.title || 'Implementation walkthrough',
    avatar_id,
    ...(voice_id ? { voice_id } : {}),
    script,
    resolution: '720p',
    aspect_ratio: '16:9',
  };

  const res = await hg('/v3/videos', { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data?.error || data?.message || `generate ${res.status}`, raw: data }, 502);
  return json({ video_id: data?.data?.video_id || data?.video_id || null, raw: data });
};

export const config = { path: '/api/gen-impl-video' };

// Security wrapper: allowlisted CORS + operator auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: operatorGuard() });
