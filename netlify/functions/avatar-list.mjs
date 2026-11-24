import { withCors } from './_auth.mjs';
import { operatorGuard } from './_tenant.mjs';
/**
 * List the LiveAvatar avatars in your account.
 *
 * Use this once to find your trained avatar's id, then set it as
 * LIVEAVATAR_AVATAR_ID in your Netlify env so the live demo uses it.
 *
 * GET /api/avatar-list
 *   → { count, avatars: [{ id, name, status, type, preview_url, voice }] }
 *
 * Env: LIVEAVATAR_API_KEY (or HEYGEN_API_KEY)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const API_URL = 'https://api.liveavatar.com';

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!apiKey) return json({ error: 'LIVEAVATAR_API_KEY not set' }, 500);

  try {
    const res = await fetch(`${API_URL}/v1/avatars?page_size=100`, {
      headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json' },
    });

    if (!res.ok) {
      const err = await res.text();
      return json({ error: `Avatar list failed: ${res.status} ${err}` }, 502);
    }

    const data = await res.json();
    const results = data?.data?.results || [];
    const avatars = results.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      type: a.type,
      preview_url: a.preview_url,
      voice: a.default_voice?.name || null,
    }));

    return json({ count: data?.data?.count ?? avatars.length, avatars });
  } catch (err) {
    console.error('[avatar-list] Error:', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/avatar-list' };

// Security wrapper: allowlisted CORS + operator auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: operatorGuard() });
