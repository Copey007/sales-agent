/**
 * MCP-Style Connector Layer
 * 
 * Standardized interface for all external tools — the "USB-C of AI" pattern
 * from Delos. Each connector has:
 *   - name: unique identifier
 *   - tools: array of { name, description, parameters, execute }
 * 
 * Agents call tools via a uniform interface: connector.invoke(toolName, params)
 * instead of reaching into bespoke API wrappers.
 * 
 * This replaces the scattered integrations/*.js and inline fetch calls
 * with a single registry that any agent can use.
 */

// ─── Connector Base ────────────────────────────────────────────────────────────

class Connector {
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.tools = {};
  }

  register(toolName, description, paramSchema, executeFn) {
    this.tools[toolName] = { name: toolName, description, parameters: paramSchema, execute: executeFn };
    return this;
  }

  async invoke(toolName, params = {}) {
    const tool = this.tools[toolName];
    if (!tool) throw new Error(`Connector "${this.name}" has no tool "${toolName}"`);
    return await tool.execute(params);
  }

  listTools() {
    return Object.values(this.tools).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }
}

// ─── Registry ──────────────────────────────────────────────────────────────────

const registry = {};

function registerConnector(connector) {
  registry[connector.name] = connector;
  return connector;
}

function getConnector(name) {
  return registry[name];
}

function listConnectors() {
  return Object.values(registry).map(c => ({
    name: c.name,
    description: c.description,
    tools: c.listTools()
  }));
}

/**
 * Universal invoke — any agent can call any tool from any connector
 * Usage: invoke('hunter', 'find_email', { firstName, lastName, domain })
 */
async function invoke(connectorName, toolName, params = {}) {
  const connector = registry[connectorName];
  if (!connector) throw new Error(`Unknown connector: ${connectorName}`);
  return await connector.invoke(toolName, params);
}

/**
 * Get env var from Netlify or process.env (works in both contexts)
 */
function env(key, fallback = null) {
  if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
    return Netlify.env.get(key) || fallback;
  }
  return process.env[key] || fallback;
}

// ─── Hunter.io Connector (Email Enrichment) ────────────────────────────────────

function createHunterConnector() {
  const c = new Connector('hunter', 'Email enrichment via Hunter.io — find and verify emails');

  c.register('find_email', 'Find email for a person at a company domain', {
    firstName: { type: 'string', required: true },
    lastName: { type: 'string', required: true },
    domain: { type: 'string', required: true }
  }, async ({ firstName, lastName, domain }) => {
    const apiKey = env('HUNTER_API_KEY');
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');
    const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.data?.email) {
      return { found: true, email: data.data.email, score: data.data.score, source: data.data.source || 'hunter' };
    }
    return { found: false, email: null, source: 'not_found' };
  });

  c.register('domain_search', 'Find emails for a domain (company)', {
    domain: { type: 'string', required: true },
    limit: { type: 'number', default: 10 }
  }, async ({ domain, limit = 10 }) => {
    const apiKey = env('HUNTER_API_KEY');
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=${limit}&api_key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      found: (data.data?.emails || []).length > 0,
      emails: (data.data?.emails || []).map(e => ({
        email: e.email,
        firstName: e.first_name,
        lastName: e.last_name,
        position: e.position,
        confidence: e.confidence
      })),
      pattern: data.data?.pattern || null
    };
  });

  c.register('verify_email', 'Verify an email address', {
    email: { type: 'string', required: true }
  }, async ({ email }) => {
    const apiKey = env('HUNTER_API_KEY');
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');
    const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      email,
      status: data.data?.status || 'unknown',
      result: data.data?.result || 'unknown',
      score: data.data?.score || 0
    };
  });

  c.register('quota', 'Check Hunter.io API quota', {}, async () => {
    const apiKey = env('HUNTER_API_KEY');
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');
    const url = `https://api.hunter.io/v2/account?api_key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      searchesUsed: data.data?.requests?.searches || 0,
      searchesLimit: data.data?.plan_limits?.searches || 0
    };
  });

  return c;
}

// ─── Serper.dev Connector (Web Search) ─────────────────────────────────────────

function createSerperConnector() {
  const c = new Connector('serper', 'Web search via Serper.dev (Google results)');

  c.register('search', 'Search the web', {
    query: { type: 'string', required: true },
    num: { type: 'number', default: 10 }
  }, async ({ query, num = 10 }) => {
    const apiKey = env('SERP_API_KEY');
    if (!apiKey) throw new Error('SERP_API_KEY not set');
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ q: query, num })
    });
    const data = await res.json();
    return {
      query,
      knowledgeGraph: data.knowledgeGraph || null,
      results: (data.organic || []).map(r => ({
        title: r.title,
        snippet: r.snippet || '',
        link: r.link,
        date: r.date || null
      })),
      answerBox: data.answerBox || null,
      peopleAlsoAsk: data.peopleAlsoAsk || []
    };
  });

  c.register('news', 'Search news articles', {
    query: { type: 'string', required: true },
    num: { type: 'number', default: 10 }
  }, async ({ query, num = 10 }) => {
    const apiKey = env('SERP_API_KEY');
    if (!apiKey) throw new Error('SERP_API_KEY not set');
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ q: query, num })
    });
    const data = await res.json();
    return (data.news || []).map(r => ({
      title: r.title,
      snippet: r.snippet || '',
      link: r.link,
      source: r.source || '',
      date: r.date || null
    }));
  });

  return c;
}

// ─── Supabase Connector (Database) ─────────────────────────────────────────────

function createSupabaseConnector() {
  const c = new Connector('supabase', 'Supabase database — contacts, sequences, activity, memory');

  function getCredentials() {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/ANON_KEY required');
    return { url, key };
  }

  c.register('query', 'Query a Supabase table', {
    table: { type: 'string', required: true },
    select: { type: 'string', default: '*' },
    filter: { type: 'string', description: 'PostgREST filter, e.g. "status=eq.sent&order=created_at.desc&limit=10"' }
  }, async ({ table, select = '*', filter = '' }) => {
    const { url, key } = getCredentials();
    const path = `/rest/v1/${table}?select=${encodeURIComponent(select)}${filter ? '&' + filter : ''}`;
    const res = await fetch(`${url}${path}`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
    return await res.json();
  });

  c.register('insert', 'Insert rows into a Supabase table', {
    table: { type: 'string', required: true },
    data: { type: 'object', required: true }
  }, async ({ table, data }) => {
    const { url, key } = getCredentials();
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': key, 'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Supabase insert error ${res.status}: ${await res.text()}`);
    return await res.json();
  });

  c.register('update', 'Update rows in a Supabase table', {
    table: { type: 'string', required: true },
    data: { type: 'object', required: true },
    filter: { type: 'string', required: true, description: 'PostgREST filter, e.g. "id=eq.123"' }
  }, async ({ table, data, filter }) => {
    const { url, key } = getCredentials();
    const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
      method: 'PATCH',
      headers: {
        'apikey': key, 'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Supabase update error ${res.status}: ${await res.text()}`);
    return await res.json();
  });

  c.register('upsert', 'Upsert rows into a Supabase table', {
    table: { type: 'string', required: true },
    data: { type: 'object', required: true },
    onConflict: { type: 'string', description: 'Column name for conflict resolution' }
  }, async ({ table, data, onConflict }) => {
    const { url, key } = getCredentials();
    const headers = {
      'apikey': key, 'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation,resolution=merge-duplicates'
    };
    if (onConflict) headers['on-conflict'] = onConflict;
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Supabase upsert error ${res.status}: ${await res.text()}`);
    return await res.json();
  });

  return c;
}

// ─── OpenAI/LLM Connector ──────────────────────────────────────────────────────

function createLLMConnector() {
  const c = new Connector('llm', 'LLM inference via OpenAI-compatible API');

  c.register('chat', 'Send a chat completion request', {
    messages: { type: 'array', required: true },
    temperature: { type: 'number', default: 0.7 },
    maxTokens: { type: 'number', default: 2000 },
    model: { type: 'string', description: 'Override default model' }
  }, async ({ messages, temperature = 0.7, maxTokens = 2000, model }) => {
    const apiKey = env('OPENAI_API_KEY');
    const apiBase = env('OPENAI_API_BASE', 'https://api.openai.com/v1');
    const defaultModel = env('LLM_MODEL', 'gpt-4o-mini');
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || defaultModel, messages, temperature, max_tokens: maxTokens })
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      model: data.model,
      usage: data.usage
    };
  });

  c.register('embed', 'Generate embeddings for text (for semantic memory)', {
    text: { type: 'string', required: true },
    model: { type: 'string', default: 'text-embedding-3-small' }
  }, async ({ text, model = 'text-embedding-3-small' }) => {
    const apiKey = env('OPENAI_API_KEY');
    const apiBase = env('OPENAI_API_BASE', 'https://api.openai.com/v1');
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const res = await fetch(`${apiBase}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ input: text, model })
    });
    if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      embedding: data.data?.[0]?.embedding || [],
      model: data.model,
      usage: data.usage
    };
  });

  return c;
}

// ─── Resend Connector (Email Sending) ──────────────────────────────────────────

function createResendConnector() {
  const c = new Connector('resend', 'Email sending via Resend');

  c.register('send', 'Send an email', {
    to: { type: 'string', required: true },
    from: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    html: { type: 'string', required: true },
    replyTo: { type: 'string' }
  }, async ({ to, from, subject, html, replyTo }) => {
    const apiKey = env('RESEND_API_KEY');
    if (!apiKey) throw new Error('RESEND_API_KEY not set');

    const body = { to, from, subject, html };
    if (replyTo) body.reply_to = replyTo;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
    return await res.json();
  });

  return c;
}

// ─── Initialize all connectors ─────────────────────────────────────────────────

let initialized = false;

function initConnectors() {
  if (initialized) return;
  registerConnector(createHunterConnector());
  registerConnector(createSerperConnector());
  registerConnector(createSupabaseConnector());
  registerConnector(createLLMConnector());
  registerConnector(createResendConnector());
  initialized = true;
}

// ─── Export ────────────────────────────────────────────────────────────────────

export {
  Connector,
  registerConnector,
  getConnector,
  listConnectors,
  invoke,
  initConnectors,
  env
};
