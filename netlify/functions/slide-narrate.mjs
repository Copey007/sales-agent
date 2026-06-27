/**
 * Auto-generate a spoken narration for a presentation slide.
 *
 * POST /api/slide-narrate  (Authorization: Bearer <jwt>)
 *   { slug, slide_url, title }
 *   → { narration }
 *
 * For image slides it reads the slide via vision; for PDFs (or if vision is
 * unavailable) it writes from the slide title + the agent's persona/knowledge.
 * Returns spoken-English narration in the agent's voice.
 */

import { callLLM } from './_llm.mjs';
import { userFromToken } from './_tenant.mjs';
import { getAgentBySlug } from './_avatar-store.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  let b = {};
  try { b = await req.json(); } catch {}
  const slug = b.slug, url = b.slide_url, title = (b.title || '').trim();
  if (!url) return json({ error: 'slide_url required' }, 400);

  const agent = slug ? await getAgentBySlug(slug) : null;
  const name = agent?.name || 'the company';
  const isImage = /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);

  const system = [
    `You write what a live AI presenter avatar for ${name} SAYS OUT LOUD while showing a slide to a prospective customer.`,
    agent?.system_prompt ? `Persona: ${agent.system_prompt}` : '',
    agent?.knowledge ? `Background knowledge you may draw on: ${agent.knowledge}` : '',
    `Rules: natural spoken English, first person, warm and on-brand, 3–5 sentences, no markdown, no headings, no stage directions, no quotation marks. End by inviting the next step or question.`,
  ].filter(Boolean).join('\n');

  const userText = isImage
    ? `Present this slide${title ? ` ("${title}")` : ''}. Read what's on it and explain/sell it in your own voice.`
    : `Write the narration to present a slide titled "${title || 'Overview'}" about ${name}, using the persona and knowledge above.`;

  const userContent = isImage
    ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url } }]
    : userText;

  try {
    let narration = await callLLM(
      [{ role: 'system', content: system }, { role: 'user', content: userContent }],
      { temperature: 0.6, maxTokens: 260 }
    );
    narration = (narration || '').trim().replace(/^["']|["']$/g, '');
    if (!narration) throw new Error('empty narration');
    return json({ narration });
  } catch (err) {
    // Vision/model failure → fall back to a text-only attempt.
    try {
      const fallback = await callLLM(
        [{ role: 'system', content: system }, { role: 'user', content: `Write the narration to present a slide titled "${title || 'Overview'}" about ${name}.` }],
        { temperature: 0.6, maxTokens: 260 }
      );
      return json({ narration: (fallback || '').trim().replace(/^["']|["']$/g, '') });
    } catch (e2) {
      console.error('[slide-narrate]', err.message, e2.message);
      return json({ error: 'Could not generate narration. Try again.' }, 502);
    }
  }
};

export const config = { path: '/api/slide-narrate' };
