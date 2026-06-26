/**
 * TTS Proxy — bypasses CORS for Google Translate TTS
 * 
 * GET /api/tts?text=Hello&lang=en
 * Returns: audio/mpeg directly
 */

export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const text = url.searchParams.get('text') || 'Hello';
  const lang = url.searchParams.get('lang') || 'en';

  if (!text || text.length > 500) {
    return new Response(JSON.stringify({ error: 'text parameter required (max 500 chars)' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=${lang}&client=tw-ob`;
    
    const res = await fetch(ttsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'audio/mpeg, audio/*, */*',
        'Referer': 'https://translate.google.com/'
      }
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `TTS fetch failed: ${res.status}` }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const audioBuffer = await res.arrayBuffer();

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.byteLength.toString(),
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/tts" };
