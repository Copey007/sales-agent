/**
 * TTS Proxy — Microsoft Edge Neural TTS
 * 
 * Uses the msedge-tts package to access Microsoft Edge's Read Aloud API.
 * These are the same neural voices used by Edge browser's Read Aloud feature.
 * Free, no API key, extremely natural sounding.
 * 
 * GET /api/tts?text=Hello&voice=Aria&lang=en
 * Returns: audio/mpeg directly
 */

import { MsEdgeTTS } from 'msedge-tts';

export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const text = url.searchParams.get('text') || '';
  const voiceName = url.searchParams.get('voice') || 'Aria';
  const lang = url.searchParams.get('lang') || 'en-US';

  if (!text || text.length > 500) {
    return new Response(JSON.stringify({ error: 'text parameter required (max 500 chars)' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // Map short voice names to full Edge TTS voice IDs
  const voices = {
    'Aria': 'en-US-AriaNeural',
    'Jenny': 'en-US-JennyNeural',
    'Guy': 'en-US-GuyNeural',
    'Ana': 'en-US-AnaNeural',
    'Emma': 'en-US-EmmaNeural',
    'Brian': 'en-GB-BrianNeural',
    'Sonia': 'en-GB-SoniaNeural',
    'Libby': 'en-GB-LibbyNeural',
  };
  const fullVoice = voices[voiceName] || `en-US-${voiceName}Neural` || 'en-US-AriaNeural';

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(fullVoice, 'audio-24khz-48kbitrate-mono-mp3');

    const { audioStream } = tts.toStream(text.slice(0, 500));

    // Collect audio chunks into a buffer
    const chunks = [];
    const buffer = await new Promise((resolve, reject) => {
      audioStream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', reject);
      
      // Safety timeout
      setTimeout(() => reject(new Error('TTS timeout')), 15000);
    });

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=86400',
        ...corsHeaders
      }
    });
  } catch (err) {
    console.error('[tts] Error:', err.message);
    
    // Fallback to Google Translate TTS if Edge TTS fails
    try {
      const googleUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=${lang.split('-')[0]}&client=tw-ob`;
      const res = await fetch(googleUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://translate.google.com/' }
      });
      if (res.ok) {
        const audioBuffer = await res.arrayBuffer();
        return new Response(audioBuffer, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'public, max-age=86400',
            ...corsHeaders
          }
        });
      }
    } catch(e) {}
    
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/tts" };
