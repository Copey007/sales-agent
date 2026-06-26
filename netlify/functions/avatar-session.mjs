/**
 * LiveAvatar Session API
 * 
 * Creates a real-time streaming avatar session via LiveAvatar (HeyGen).
 * Returns WebRTC credentials for the browser to connect and receive
 * live avatar video.
 * 
 * POST /api/avatar-session  { action: "start" }
 *   → { session_id, livekit_url, livekit_client_token, websocket_url }
 * 
 * POST /api/avatar-session  { action: "stop", session_id }
 *   → { success: true }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const action = body.action || 'start';

    // Read the LiveAvatar API key
    const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'LIVEAVATAR_API_KEY not set' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (action === 'start') {
      return await startSession(apiKey, body, corsHeaders);
    } else if (action === 'stop') {
      return await stopSession(apiKey, body, corsHeaders);
    } else {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  } catch (err) {
    console.error('[avatar-session] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/avatar-session" };

async function startSession(apiKey, body, corsHeaders) {
  const avatarId = body.avatar_id || '8175dfc2-7858-49d6-b5fa-0c135d1c4bad'; // Elenora Tech Expert
  
  // First, stop any existing sessions to avoid concurrency limit
  try {
    const listRes = await fetch('https://api.liveavatar.com/v1/sessions?type=active', {
      headers: { 'X-API-KEY': apiKey, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const sessions = listData?.data?.results || [];
      for (const s of sessions) {
        const sid = s.session_id || s.id;
        if (sid) {
          await fetch('https://api.liveavatar.com/v1/sessions/stop', {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ session_id: sid })
          });
        }
      }
    }
  } catch(e) { /* non-fatal */ }
  
  // Step 1: Create session token
  const tokenBody = JSON.stringify({
    avatar_id: avatarId,
    mode: 'LITE',
    is_sandbox: false,
    video_settings: { quality: 'high', encoding: 'H264' }
  });

  const tokenRes = await fetch('https://api.liveavatar.com/v1/sessions/token', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body: tokenBody
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token creation failed: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  const sessionToken = tokenData.data.session_token;
  const sessionId = tokenData.data.session_id;

  // Step 2: Start the session
  const startRes = await fetch('https://api.liveavatar.com/v1/sessions/start', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'Authorization': `Bearer ${sessionToken}`
    },
    body: JSON.stringify({ session_token: sessionToken })
  });

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Session start failed: ${startRes.status} ${err}`);
  }

  const startData = await startRes.json();
  const data = startData.data;

  return new Response(JSON.stringify({
    success: true,
    session_id: sessionId,
    livekit_url: data.livekit_url,
    livekit_client_token: data.livekit_client_token,
    livekit_agent_token: data.livekit_agent_token,
    ws_url: data.ws_url,
    max_session_duration: data.max_session_duration,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function stopSession(apiKey, body, corsHeaders) {
  const sessionId = body.session_id;
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'session_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const res = await fetch(`https://api.liveavatar.com/v1/sessions/stop`, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({ session_id: sessionId })
  });

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
