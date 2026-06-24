/**
 * Supabase Memory Module
 * 
 * Replaces the file-based memory/short_term.js, long_term.js, and working.js
 * with a unified Supabase-backed store that supports:
 *   - Persistent long-term memory (account research, signals, contacts, notes)
 *   - Semantic recall via pgvector embeddings (find similar memories)
 *   - Working memory via the agent_tasks table
 *   - Per-agent isolation (agent_id scoping)
 * 
 * Uses the MCP connector layer for all Supabase calls.
 */

import { invoke, env, initConnectors } from './_mcp-connectors.mjs';

// ─── Initialization ────────────────────────────────────────────────────────────

let _initialized = false;

function ensureInit() {
  if (!_initialized) {
    initConnectors();
    _initialized = true;
  }
}

function getCredentials() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for memory module');
  return { url, key };
}

// ─── Long-Term Memory ──────────────────────────────────────────────────────────

/**
 * Store a memory fragment with optional embedding for semantic recall.
 * 
 * @param {Object} params
 * @param {string} params.agentId - Which agent is storing this (e.g. 'researcher')
 * @param {string} params.accountId - Optional account/company scoping
 * @param {string} params.memoryType - 'research' | 'contact' | 'signal' | 'note' | 'email_sent' | 'reply' | 'campaign_result' | 'lesson'
 * @param {string} params.content - The memory content (human-readable text)
 * @param {Object} params.metadata - Structured data to store alongside
 * @param {boolean} params.embed - Whether to generate an embedding (default: true for text > 10 chars)
 */
async function remember({ agentId = 'default', accountId = null, memoryType = 'note', content, metadata = {}, embed = null }) {
  ensureInit();
  const { url, key } = getCredentials();

  // Auto-decide whether to embed
  const shouldEmbed = embed !== null ? embed : (content.length > 10);

  let embedding = null;
  if (shouldEmbed) {
    try {
      const embedResult = await invoke('llm', 'embed', { text: content.slice(0, 8000) });
      embedding = embedResult.embedding;
    } catch (e) {
      console.warn('[memory] Embedding failed, storing without vector:', e.message);
    }
  }

  const row = {
    agent_id: agentId,
    account_id: accountId,
    memory_type: memoryType,
    content,
    metadata
  };

  // Insert via Supabase REST API
  // Note: embedding is sent as a string literal for pgvector
  const res = await fetch(`${url}/rest/v1/agent_memory`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    // If agent_memory table doesn't exist, fall back gracefully
    if (res.status === 404) {
      console.warn('[memory] agent_memory table not found — memory not stored. Run schema setup first.');
      return { stored: false, reason: 'table_not_found' };
    }
    throw new Error(`Memory insert failed: ${res.status} ${await res.text()}`);
  }

  const result = await res.json();

  // If we have an embedding, update the row with it
  if (embedding && embedding.length > 0 && result[0]?.id) {
    try {
      await fetch(`${url}/rest/v1/agent_memory?id=eq.${result[0].id}`, {
        method: 'PATCH',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ embedding: `[${embedding.join(',')}]` })
      });
    } catch (e) {
      console.warn('[memory] Failed to store embedding:', e.message);
    }
  }

  return { stored: true, id: result[0]?.id };
}

/**
 * Recall memories by semantic similarity to a query.
 * Generates an embedding for the query, then finds the closest matches.
 * 
 * @param {Object} params
 * @param {string} params.query - Text to search for
 * @param {number} params.matchCount - Max results (default 5)
 * @param {string} params.agentId - Filter to specific agent
 * @param {string} params.accountId - Filter to specific account
 * @param {string} params.memoryType - Filter to specific memory type
 */
async function recall({ query, matchCount = 5, agentId = null, accountId = null, memoryType = null }) {
  ensureInit();
  const { url, key } = getCredentials();

  // Generate embedding for the query
  let queryEmbedding;
  try {
    const embedResult = await invoke('llm', 'embed', { text: query.slice(0, 8000) });
    queryEmbedding = embedResult.embedding;
  } catch (e) {
    // Fallback: text search without embeddings
    console.warn('[memory] Embedding failed for recall, falling back to text search');
    return await recallByText({ query, matchCount, agentId, accountId, memoryType });
  }

  // Call the search_memory RPC
  const rpcBody = {
    query_embedding: `[${queryEmbedding.join(',')}]`,
    match_count: matchCount
  };
  if (agentId) rpcBody.filter_agent_id = agentId;
  if (accountId) rpcBody.filter_account_id = accountId;
  if (memoryType) rpcBody.filter_memory_type = memoryType;

  const res = await fetch(`${url}/rest/v1/rpc/search_memory`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(rpcBody)
  });

  if (!res.ok) {
    console.warn(`[memory] Semantic search failed (${res.status}), falling back to text search`);
    return await recallByText({ query, matchCount, agentId, accountId, memoryType });
  }

  return await res.json();
}

/**
 * Fallback: text search via PostgREST ilike filter
 */
async function recallByText({ query, matchCount = 5, agentId = null, accountId = null, memoryType = null }) {
  const { url, key } = getCredentials();

  let filter = `limit=${matchCount}&order=created_at.desc`;
  if (agentId) filter += `&agent_id=eq.${encodeURIComponent(agentId)}`;
  if (accountId) filter += `&account_id=eq.${encodeURIComponent(accountId)}`;
  if (memoryType) filter += `&memory_type=eq.${encodeURIComponent(memoryType)}`;
  filter += `&content=ilike.*${encodeURIComponent(query)}*`;

  const res = await fetch(`${url}/rest/v1/agent_memory?select=id,agent_id,account_id,memory_type,content,metadata,created_at&${filter}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });

  if (!res.ok) return [];
  const results = await res.json();
  return results.map(r => ({ ...r, similarity: 0 }));
}

/**
 * Get all memories for a specific account (no semantic search, just list)
 */
async function getAccountMemories({ accountId, agentId = null, memoryType = null, limit = 50 }) {
  ensureInit();
  const { url, key } = getCredentials();

  let filter = `account_id=eq.${encodeURIComponent(accountId)}&limit=${limit}&order=created_at.desc`;
  if (agentId) filter += `&agent_id=eq.${encodeURIComponent(agentId)}`;
  if (memoryType) filter += `&memory_type=eq.${encodeURIComponent(memoryType)}`;

  const res = await fetch(`${url}/rest/v1/agent_memory?select=id,agent_id,account_id,memory_type,content,metadata,created_at&${filter}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });

  if (!res.ok) return [];
  return await res.json();
}

/**
 * Check if we already have research/knowledge about an account
 */
async function alreadyKnow({ accountId, neededTypes = ['research'] }) {
  const memories = await getAccountMemories({ accountId, limit: 100 });
  const foundTypes = new Set(memories.map(m => m.memory_type));
  const missing = neededTypes.filter(t => !foundTypes.has(t));
  return {
    knows: missing.length === 0,
    missing,
    memories
  };
}

// ─── Working Memory (Task-based) ───────────────────────────────────────────────

/**
 * Create a working task (replaces memory/working.js)
 */
async function createTask({ taskId, delegatedBy, delegatedTo, objective, context = {}, priority = 5, parentTaskId = null }) {
  ensureInit();
  const { url, key } = getCredentials();

  const res = await fetch(`${url}/rest/v1/agent_tasks`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      task_id: taskId,
      parent_task_id: parentTaskId,
      delegated_by: delegatedBy,
      delegated_to: delegatedTo,
      objective,
      context,
      status: 'pending',
      priority
    })
  });

  if (!res.ok) {
    console.warn('[memory] Failed to create task:', res.status);
    return null;
  }
  return (await res.json())[0];
}

/**
 * Update task status
 */
async function updateTask({ taskId, status, result = null, error = null }) {
  ensureInit();
  const { url, key } = getCredentials();

  const updates = { status };
  if (status === 'in_progress') updates.started_at = new Date().toISOString();
  if (status === 'completed' || status === 'failed') updates.completed_at = new Date().toISOString();
  if (result) updates.result = result;
  if (error) updates.error = error;

  const res = await fetch(`${url}/rest/v1/agent_tasks?task_id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(updates)
  });

  if (!res.ok) return null;
  return (await res.json())[0];
}

/**
 * Get pending tasks for an agent
 */
async function getPendingTasks({ agentId, limit = 10 }) {
  ensureInit();
  const { url, key } = getCredentials();

  const res = await fetch(`${url}/rest/v1/agent_tasks?delegated_to=eq.${encodeURIComponent(agentId)}&status=eq.pending&order=priority.asc,created_at.asc&limit=${limit}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
  });

  if (!res.ok) return [];
  return await res.json();
}

// ─── Export ────────────────────────────────────────────────────────────────────

export {
  remember,
  recall,
  recallByText,
  getAccountMemories,
  alreadyKnow,
  createTask,
  updateTask,
  getPendingTasks
};
