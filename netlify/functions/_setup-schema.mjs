/**
 * One-time schema setup function.
 * POST /api/setup-schema with { secret: "setup" } to create tables.
 * DELETE after setup is complete.
 */
import { env } from './_mcp-connectors.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const body = await req.json().catch(() => ({}));
    
    // Simple auth check
    const setupSecret = env('QUEUE_MANAGER_SECRET', 'setup');
    if (body.secret !== setupSecret && body.secret !== 'setup') {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const supabaseUrl = env('SUPABASE_URL');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase credentials' }), { status: 500, headers: corsHeaders });
    }

    // Read the schema SQL
    const fs = await import('fs');
    const path = await import('path');
    const schemaPath = path.join(process.cwd(), 'netlify', 'functions', 'schema.sql');
    let schemaSQL;
    try {
      schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    } catch {
      // If file not found, inline the SQL
      schemaSQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'default',
  account_id TEXT,
  memory_type TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_account ON agent_memory(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT UNIQUE NOT NULL,
  agent_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'idle',
  capabilities JSONB DEFAULT '[]'::jsonb,
  config JSONB DEFAULT '{}'::jsonb,
  current_task TEXT,
  last_action TEXT,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_registry_type ON agent_registry(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id TEXT UNIQUE NOT NULL,
  parent_task_id TEXT,
  delegated_by TEXT NOT NULL,
  delegated_to TEXT NOT NULL,
  objective TEXT NOT NULL,
  context JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'pending',
  result JSONB,
  error TEXT,
  priority INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_delegated_to ON agent_tasks(delegated_to);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER IF NOT EXISTS agent_memory_updated_at
  BEFORE UPDATE ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER IF NOT EXISTS agent_registry_updated_at
  BEFORE UPDATE ON agent_registry
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION search_memory(
  query_embedding VECTOR(1536),
  match_count INTEGER DEFAULT 5,
  filter_agent_id TEXT DEFAULT NULL,
  filter_account_id TEXT DEFAULT NULL,
  filter_memory_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  account_id TEXT,
  memory_type TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT id, agent_id, account_id, memory_type, content, metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM agent_memory
  WHERE (filter_agent_id IS NULL OR agent_id = filter_agent_id)
    AND (filter_account_id IS NULL OR account_id = filter_account_id)
    AND (filter_memory_type IS NULL OR memory_type = filter_memory_type)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

INSERT INTO agent_registry (agent_id, agent_type, name, description, status, capabilities)
VALUES
  ('manager', 'manager', 'Mission Control Manager', 'Receives high-level objectives and delegates to specialist agents', 'idle', '["supabase.query","llm.chat"]'),
  ('researcher', 'researcher', 'A-Gent Researcher', 'Sources prospects via Hunter.io, gathers buying signals via web search', 'idle', '["hunter.find_email","hunter.domain_search","hunter.verify_email","serper.search","serper.news","supabase.insert","supabase.query","llm.chat","llm.embed"]'),
  ('sdr', 'sdr', 'A-Gent SDR', 'Generates GAP-methodology emails and manages outbound sequences', 'idle', '["llm.chat","llm.embed","resend.send","supabase.query","supabase.insert","supabase.update"]'),
  ('ops', 'ops', 'A-Gent Ops', 'Manages queue scheduling, throttling, daily limits, and system health', 'idle', '["supabase.query","supabase.update","supabase.insert"]'),
  ('support', 'support', 'A-Gent Support', 'Handles inbound customer questions and routes issues', 'idle', '["supabase.query","supabase.insert","llm.chat"]'),
  ('success', 'success', 'A-Gent Success', 'Monitors customer health, triggers retention plays, manages renewals', 'idle', '["supabase.query","supabase.update","llm.chat","resend.send"]'),
  ('social', 'social', 'A-Gent Social', 'Manages social media publishing and engagement tracking', 'idle', '["llm.chat","supabase.query"]')
ON CONFLICT (agent_id) DO NOTHING;
`;
    }

    // Execute SQL via Supabase's PostgreSQL connection
    // Use the REST API with the service role key to create tables
    // We'll use the /pg/query endpoint (Supabase's direct SQL execution)
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: schemaSQL })
    });

    if (!res.ok) {
      // Fallback: try creating tables one by one via REST API
      const errorText = await res.text();
      
      // Try direct table creation via REST
      const results = [];
      
      // Create agent_registry first (no dependencies)
      const regRes = await fetch(`${supabaseUrl}/rest/v1/agent_registry`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          agent_id: 'manager',
          agent_type: 'manager',
          name: 'Mission Control Manager',
          description: 'Receives high-level objectives and delegates to specialist agents',
          status: 'idle',
          capabilities: ['supabase.query', 'llm.chat']
        })
      });
      
      if (regRes.ok) {
        results.push('agent_registry: seeded manager');
      } else {
        results.push(`agent_registry: ${regRes.status} (may already exist)`);
      }

      // Seed more agents
      const agents = [
        { agent_id: 'researcher', agent_type: 'researcher', name: 'A-Gent Researcher', description: 'Sources prospects via Hunter.io', status: 'idle', capabilities: ['hunter.find_email', 'serper.search', 'supabase.insert', 'llm.chat'] },
        { agent_id: 'sdr', agent_type: 'sdr', name: 'A-Gent SDR', description: 'Generates GAP emails and manages outbound', status: 'idle', capabilities: ['llm.chat', 'resend.send', 'supabase.query', 'supabase.insert'] },
        { agent_id: 'ops', agent_type: 'ops', name: 'A-Gent Ops', description: 'Manages queue and system health', status: 'idle', capabilities: ['supabase.query', 'supabase.update'] },
        { agent_id: 'support', agent_type: 'support', name: 'A-Gent Support', description: 'Handles inbound questions', status: 'idle', capabilities: ['supabase.query', 'llm.chat'] },
        { agent_id: 'success', agent_type: 'success', name: 'A-Gent Success', description: 'Monitors customer health', status: 'idle', capabilities: ['supabase.query', 'llm.chat', 'resend.send'] },
        { agent_id: 'social', agent_type: 'social', name: 'A-Gent Social', description: 'Manages social media', status: 'idle', capabilities: ['llm.chat', 'supabase.query'] }
      ];

      for (const agent of agents) {
        const aRes = await fetch(`${supabaseUrl}/rest/v1/agent_registry`, {
          method: 'POST',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation,resolution=merge-duplicates'
          },
          body: JSON.stringify(agent)
        });
        results.push(`${agent.agent_id}: ${aRes.status}`);
      }

      return new Response(JSON.stringify({ 
        note: 'Direct SQL not available via REST. Attempted REST API seeding.',
        results 
      }), { status: 200, headers: corsHeaders });
    }

    const result = await res.json();
    return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers: corsHeaders });
  }
};

export const config = { path: "/api/setup-schema" };
