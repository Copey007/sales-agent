-- A-Gent Workforce Memory Schema
-- Run this in the Supabase SQL Editor to create the agent memory tables.
-- These replace the file-based memory/long_term.js, memory/short_term.js,
-- and memory/working.js with a proper vector-backed persistent store.

-- ─── Extensions ────────────────────────────────────────────────────────────────

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Agent Memory Table ───────────────────────────────────────────────────────
-- Long-term, searchable memory for all agents. Each row is a "memory fragment"
-- that can be recalled via semantic similarity search.

CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'default',
  account_id TEXT,
  memory_type TEXT NOT NULL DEFAULT 'note',
  -- memory_type: 'research' | 'contact' | 'signal' | 'note' | 'email_sent' | 'reply' | 'campaign_result' | 'lesson'
  
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Vector embedding for semantic recall (1536 dims = text-embedding-3-small)
  embedding VECTOR(1536),
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_account ON agent_memory(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created ON agent_memory(created_at DESC);

-- Vector similarity index (IVFFlat for approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding 
  ON agent_memory USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);

-- ─── Agent Registry Table ─────────────────────────────────────────────────────
-- Registry of all specialized agents in the workforce

CREATE TABLE IF NOT EXISTS agent_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT UNIQUE NOT NULL,
  agent_type TEXT NOT NULL,
  -- agent_type: 'manager' | 'researcher' | 'sdr' | 'ops' | 'support' | 'success' | 'social'
  
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'idle',
  -- status: 'idle' | 'active' | 'busy' | 'error' | 'offline'
  
  capabilities JSONB DEFAULT '[]'::jsonb,
  -- List of connector.tool names this agent can invoke
  
  config JSONB DEFAULT '{}'::jsonb,
  current_task TEXT,
  last_action TEXT,
  last_active_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_registry_type ON agent_registry(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

-- ─── Agent Task Log Table ─────────────────────────────────────────────────────
-- Tracks delegated tasks and their results (working memory replacement)

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id TEXT UNIQUE NOT NULL,
  parent_task_id TEXT,
  
  delegated_by TEXT NOT NULL,
  delegated_to TEXT NOT NULL,
  
  objective TEXT NOT NULL,
  context JSONB DEFAULT '{}'::jsonb,
  
  status TEXT DEFAULT 'pending',
  -- status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
  
  result JSONB,
  error TEXT,
  
  priority INTEGER DEFAULT 5,
  -- 1 (highest) to 10 (lowest)
  
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_delegated_to ON agent_tasks(delegated_to);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id);

-- ─── Updated_at trigger ───────────────────────────────────────────────────────

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

-- ─── RPC: Semantic memory search ──────────────────────────────────────────────
-- Called via: supabase.rpc('search_memory', { query_embedding: [...], match_count: 5 })

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
LANGUAGE sql
STABLE
AS $$
  SELECT
    id,
    agent_id,
    account_id,
    memory_type,
    content,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM agent_memory
  WHERE (filter_agent_id IS NULL OR agent_id = filter_agent_id)
    AND (filter_account_id IS NULL OR account_id = filter_account_id)
    AND (filter_memory_type IS NULL OR memory_type = filter_memory_type)
    AND expires_at IS NULL OR expires_at > now()
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ─── Seed default agents ──────────────────────────────────────────────────────

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
