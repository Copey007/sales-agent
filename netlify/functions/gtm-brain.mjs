/**
 * A-Gent GTM Brain — the platform's always-on revenue methodology core.
 *
 * The brain is HARDWIRED with Mark Cope's "The GTM REVolution" (stored in the
 * gtm_brain Blobs store at seed time). Tenants layer their own playbooks,
 * sales material, and product docs on top — but the book is always present
 * and always the analytical foundation.
 *
 * GET  /api/gtm-brain?action=status        — brain + tenant docs + analyses
 * POST {action:"upload_doc", filename, text}
 * POST {action:"delete_doc", id}
 * POST {action:"analyze", filename, text}  — raw CRM/Gong export vs the brain
 * POST {action:"seed_digest"}              — one-off: distill book principles
 */

import { resolveTenantContext } from './_tenant.mjs';
import { callLLM, parseLLMJson, isLlmConfigIncompleteError } from './_llm.mjs';
import { DEFAULTS, logActivity } from './_campaign-store.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });

async function store(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore(name);
}

// ─── Brain core (hardwired book) ─────────────────────────────────────────────

async function bookMeta() {
  try { return await (await store('gtm_brain')).get('book_meta', { type: 'json' }); } catch { return null; }
}
async function bookChunks() {
  try { return (await (await store('gtm_brain')).get('book_chunks', { type: 'json' }))?.chunks || []; } catch { return []; }
}
async function bookDigest() {
  try { return await (await store('gtm_brain')).get('book_digest', { type: 'json' }); } catch { return null; }
}

// Lightweight retrieval: score book chunks against query terms, take top K.
function topChunks(chunks, queryText, k = 8) {
  const terms = [...new Set(String(queryText).toLowerCase().match(/[a-z]{4,}/g) || [])].slice(0, 120);
  const scored = chunks.map(c => {
    const hay = (c.h + ' ' + c.t).toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    return { c, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map(x => x.c);
}

// ─── Tenant docs ─────────────────────────────────────────────────────────────

async function listDocs(tenantId) {
  const s = await store('gtm_docs');
  const { blobs = [] } = await s.list({ prefix: `${tenantId}/` });
  const out = [];
  for (const b of blobs) {
    try {
      const d = await s.get(b.key, { type: 'json' });
      if (d) out.push({ id: b.key, filename: d.filename, words: d.words, uploaded_at: d.uploaded_at, kind: d.kind });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
}

async function listAnalyses(tenantId) {
  const s = await store('gtm_analyses');
  const { blobs = [] } = await s.list({ prefix: `${tenantId}/` });
  const out = [];
  for (const b of blobs) {
    try { const d = await s.get(b.key, { type: 'json' }); if (d) out.push(d); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 10);
}

// ─── Raw-data profiling (CSV/JSON exports from CRM, Gong, etc.) ─────────────

function profileRawData(filename, text) {
  const profile = { filename, bytes: text.length };
  const trimmed = text.trim();
  if (/^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : (parsed.records || parsed.data || parsed.results || [parsed]);
      profile.format = 'json';
      profile.rows = rows.length;
      profile.columns = Object.keys(rows[0] || {});
      profile.sample = rows.slice(0, 12);
      return profile;
    } catch { /* fall through to CSV */ }
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const delim = (lines[0]?.match(/\t/g) || []).length > (lines[0]?.match(/,/g) || []).length ? '\t' : ',';
  const header = (lines[0] || '').split(delim).map(h => h.trim().replace(/^"|"$/g, ''));
  profile.format = 'csv';
  profile.rows = Math.max(0, lines.length - 1);
  profile.columns = header;
  profile.sample = lines.slice(1, 13).map(l => l.split(delim).slice(0, header.length));
  return profile;
}

// ─── Analysis: raw data × hardwired brain ────────────────────────────────────

async function analyzeAgainstBrain(tenantId, filename, text, tenantDocs) {
  const digest = await bookDigest();
  const chunks = await bookChunks();
  const profile = profileRawData(filename, text);

  const querySeed = `${profile.columns?.join(' ')} pipeline conversion win rate sales cycle outbound meetings revenue renewal churn ${filename}`;
  const relevant = topChunks(chunks, querySeed, 8);

  const docsNote = tenantDocs.length
    ? `The client has also loaded ${tenantDocs.length} of their own documents: ${tenantDocs.slice(0, 6).map(d => d.filename).join(', ')}.`
    : 'The client has not loaded any of their own documents yet.';

  const system = `You are the A-Gent GTM Brain — the analytical engine built on Mark Cope's book "The GTM REVolution: A New Playbook for the AI-Era Chief Revenue Officer". You assess a company's real go-to-market data against the book's methodology and tell them, directly and specifically, where their GTM is leaking revenue and what to do about it.

## Core methodology (distilled from the book)
${digest?.text || '(digest pending — reason from the excerpts below)'}

## Most relevant book excerpts for this dataset
${relevant.map(c => `### ${c.h}\n${c.t}`).join('\n\n').slice(0, 9000)}

Ground every finding in the data provided AND the methodology. Never fabricate numbers — compute only from what is present; where the data can't answer, say what to measure next. Write like a sharp CRO advisor: direct, specific, zero filler.

Return ONLY JSON (no markdown fences):
{"headline":"<one-sentence overall read>",
 "findings":[{"title":"<short>","evidence":"<numbers from their data>","book_principle":"<the GTM REVolution principle it violates/confirms>","impact":"<why it matters>"}],
 "plays":[{"title":"<short action>","detail":"<how, per the book>","priority":1}],
 "measure_next":["<metric they should pull next>"]}
EXACTLY 4 findings and 3 plays. Keep every field under 45 words — the JSON must be complete and valid.`;

  const user = `## Client raw data export
File: ${filename} (${profile.format}, ${profile.rows} rows)
Columns: ${(profile.columns || []).join(', ')}
Sample rows:
${JSON.stringify(profile.sample).slice(0, 6000)}

${docsNote}

Assess this data against the GTM REVolution methodology.`;

  const out = await callLLM([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { maxTokens: 3000, temperature: 0.4 });

  let parsed = null;
  try { parsed = parseLLMJson(out); } catch { /* fall through */ }
  if (!parsed) { try { parsed = JSON.parse((String(out).match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { /* keep raw */ } }

  const analysis = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    source_file: filename,
    profile: { format: profile.format, rows: profile.rows, columns: profile.columns },
    result: parsed || { headline: 'Analysis generated (unstructured)', raw: String(out).slice(0, 4000) },
    created_at: new Date().toISOString()
  };
  const s = await store('gtm_analyses');
  await s.setJSON(`${tenantId}/${analysis.id}`, analysis);
  await logActivity({ type: 'gtm_brain_analysis', tenant_id: tenantId, source_file: filename, rows: profile.rows });
  return analysis;
}


// ─── GTM Plan (assessment × the book) ────────────────────────────────────────

async function getPlan(tenantId) {
  try { return await (await store('gtm_plans')).get(tenantId, { type: 'json' }); } catch { return null; }
}

const ASSESSMENT_LABELS = {
  workflow: 'Outbound workflow repeatability',
  data: 'Account & contact data strength',
  signals: 'Buying-signal visibility',
  support: 'AI implementation support needed',
  gap: 'Cost of staying manual'
};

async function generatePlan(tenantId, assessment) {
  const digest = await bookDigest();
  const answers = Object.entries(assessment.answers || {})
    .map(([k, v]) => `- ${ASSESSMENT_LABELS[k] || k}: ${v}/3`).join('\n');

  const system = `You are the A-Gent GTM Brain, built on Mark Cope's "The GTM REVolution: A New Playbook for the AI-Era Chief Revenue Officer". A prospect just completed the 5-question readiness assessment. Produce their initial GTM plan strictly from the book's methodology.

## Core methodology (distilled from the book)
${digest?.text || ''}

Return ONLY JSON (no markdown fences):
{"summary":"<2-3 sentence read of where they are, direct CRO voice>",
 "priorities":[{"title":"<short>","detail":"<what to do first and why, per the book>"}],
 "quick_wins":["<thing they can do this week>"],
 "full_readout_needs":"<one sentence: what connecting their real CRM/Gong data will unlock that the questionnaire cannot>"}
EXACTLY 3 priorities and 2 quick wins. Every field under 50 words. Valid complete JSON only.`;

  const user = `Assessment result: ${assessment.title || ''} — ${assessment.pct || '?'}% readiness.
Scores (1=weakest, 3=strongest):
${answers}

Build their initial plan.`;

  const out = await callLLM([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], { maxTokens: 1200, temperature: 0.4 });

  let parsed = null;
  try { parsed = parseLLMJson(out); } catch { /* fall through */ }
  if (!parsed) { try { parsed = JSON.parse((String(out).match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { parsed = null; } }

  const plan = {
    tenant_id: tenantId,
    assessment: { pct: assessment.pct, title: assessment.title, answers: assessment.answers },
    plan: parsed || { summary: String(out).slice(0, 1200) },
    created_at: new Date().toISOString()
  };
  await (await store('gtm_plans')).setJSON(tenantId, plan);
  await logActivity({ type: 'gtm_plan_generated', tenant_id: tenantId, readiness: assessment.pct });
  return plan;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const authCtx = await resolveTenantContext(req);
  if (authCtx.invalid) return json({ error: 'unauthorized' }, 401);
  const tenantId = authCtx.tenantId || DEFAULTS.TENANT_ID;

  try {
    if (req.method === 'GET') {
      const [meta, digest, docs, analyses, plan] = await Promise.all([
        bookMeta(), bookDigest(), listDocs(tenantId), listAnalyses(tenantId), getPlan(tenantId)
      ]);
      return json({
        brain: meta ? { title: meta.title, author: meta.author, word_count: meta.word_count, chunk_count: meta.chunk_count, digest_ready: !!digest } : null,
        docs,
        analyses,
        plan,
        assessment_url: 'https://a-gent.co/assessment#assessment-flow'
      });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'upload_doc') {
      const { filename, text, kind } = body;
      if (!filename || !text) return json({ error: 'filename and text required' }, 400);
      const doc = {
        filename: String(filename).slice(0, 120),
        kind: kind || 'document',
        text: String(text).slice(0, 400000),
        words: String(text).split(/\s+/).length,
        uploaded_at: new Date().toISOString()
      };
      const id = `${tenantId}/${crypto.randomUUID()}`;
      await (await store('gtm_docs')).setJSON(id, doc);
      return json({ ok: true, id, filename: doc.filename, words: doc.words });
    }

    if (action === 'delete_doc') {
      if (!body.id || !String(body.id).startsWith(`${tenantId}/`)) return json({ error: 'invalid id' }, 400);
      await (await store('gtm_docs')).delete(body.id);
      return json({ ok: true });
    }

    if (action === 'analyze') {
      const { filename, text } = body;
      if (!filename || !text) return json({ error: 'filename and text required' }, 400);
      const docs = await listDocs(tenantId);
      const analysis = await analyzeAgainstBrain(tenantId, String(filename).slice(0, 120), String(text).slice(0, 500000), docs);
      return json({ ok: true, analysis });
    }

    if (action === 'save_assessment') {
      const { pct, title, answers } = body;
      if (!answers || typeof answers !== 'object') return json({ error: 'answers required' }, 400);
      const plan = await generatePlan(tenantId, { pct: Number(pct) || null, title: String(title || '').slice(0, 160), answers });
      return json({ ok: true, plan });
    }

    if (action === 'seed_digest') {
      const chunks = await bookChunks();
      if (!chunks.length) return json({ error: 'book not loaded' }, 422);
      // Distill in two passes to stay inside token limits.
      const half = Math.ceil(chunks.length / 2);
      const parts = [];
      for (const slice of [chunks.slice(0, half), chunks.slice(half)]) {
        const content = slice.map(c => `## ${c.h}\n${c.t}`).join('\n').slice(0, 60000);
        const out = await callLLM([
          { role: 'system', content: 'Distill this portion of a go-to-market book into its core operating principles: the diagnostic questions it asks of revenue data, the metrics it treats as truth, its plays and sequencing. Dense bullet points, max 500 words, keep the author\'s specific vocabulary and frameworks.' },
          { role: 'user', content }
        ], { maxTokens: 900, temperature: 0.2 });
        parts.push(String(out));
      }
      const digest = { id: 'book_digest', text: parts.join('\n\n'), created_at: new Date().toISOString() };
      await (await store('gtm_brain')).setJSON('book_digest', digest);
      return json({ ok: true, digest_words: digest.text.split(/\s+/).length });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    if (isLlmConfigIncompleteError(err)) {
      return json({ error: 'llm_config_incomplete' }, 502);
    }
    console.error('[gtm-brain]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/gtm-brain' };

// Security wrapper: allowlisted CORS + tenant auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: tenantGuard() });
