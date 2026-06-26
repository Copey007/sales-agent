/**
 * Generate a HeyGen video on demand from text
 * 
 * POST /api/avatar-speak  { text, voice }
 * Returns: { video_url } — a talking-head video of the avatar speaking the text
 * 
 * Uses HeyGen v3 Video Agent API. Takes ~20-30s to generate.
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
    
    const text = body.text || '';
    if (!text || text.length > 500) {
      return new Response(JSON.stringify({ error: 'text required (max 500 chars)' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const apiKey = process.env.HEYGEN_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'HEYGEN_API_KEY not set' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Step 1: Create video agent session
    const createBody = JSON.stringify({
      prompt: `A friendly female presenter says: ${text}`
    });

    const createRes = await fetch('https://api.heygen.com/v3/video-agents', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: createBody
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      return new Response(JSON.stringify({ error: `Video creation failed: ${createRes.status} ${err}` }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const createData = await createRes.json();
    const videoId = createData.data?.video_id;
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'No video_id returned' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Step 2: Poll for completion (max 60 seconds)
    const startTime = Date.now();
    const maxWait = 60000;

    while (Date.now() - startTime < maxWait) {
      const pollRes = await fetch(`https://api.heygen.com/v3/videos/${videoId}`, {
        headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
      });

      if (!pollRes.ok) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const pollData = await pollRes.json();
      const status = pollData.data?.status;
      const videoUrl = pollData.data?.video_url;

      if (status === 'completed' && videoUrl) {
        return new Response(JSON.stringify({
          success: true,
          video_url: videoUrl,
          duration: pollData.data?.duration,
          generation_time: Math.round((Date.now() - startTime) / 1000)
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (status === 'failed') {
        return new Response(JSON.stringify({ error: 'Video generation failed' }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Wait 5 seconds before polling again
      await new Promise(r => setTimeout(r, 5000));
    }

    // Timeout — return the video ID so the client can poll later
    return new Response(JSON.stringify({
      success: false,
      error: 'Video still generating',
      video_id: videoId,
      poll_url: `/api/avatar-speak?video_id=${videoId}`
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err) {
    console.error('[avatar-speak] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/avatar-speak" };
