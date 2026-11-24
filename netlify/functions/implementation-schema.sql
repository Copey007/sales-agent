-- ============================================================================
-- Implementation Agent — a second kind of live avatar agent.
-- Reuses the avatar_agents table; agent_type distinguishes a pre-sale demo
-- agent ('demo', the default) from a post-sale implementation agent
-- ('implementation') that onboards the customer and plays recorded demo clips.
-- parent_slug links an implementation agent back to the demo agent it continued.
-- Run in the Supabase SQL editor (DDL).
-- ============================================================================

ALTER TABLE avatar_agents ADD COLUMN IF NOT EXISTS agent_type  TEXT NOT NULL DEFAULT 'demo';
ALTER TABLE avatar_agents ADD COLUMN IF NOT EXISTS parent_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_avatar_agents_type ON avatar_agents(agent_type);
