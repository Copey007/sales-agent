/**
 * A-Gent Workforce API
 * 
 * The main endpoint for the Workforce module (Delos competitor).
 * Exposes agent listing, delegation, and status endpoints.
 * 
 * Endpoints:
 *   GET  /api/workforce                          — List all agents and their status
 *   POST /api/workforce  { action: "delegate" }  — Delegate an objective to the Manager
 *   POST /api/workforce  { action: "execute" }   — Execute a task directly on a specific agent
 *   POST /api/workforce  { action: "memory" }    — Store or recall memories
 *   POST /api/workforce  { action: "connectors" }— List available MCP connectors
 */

import { initAgents, getAgent, listAgents, getAgentStatuses } from './_agent-registry.mjs';
import { initConnectors, listConnectors, invoke } from './_mcp-connectors.mjs';
import { remember, recall, getAccountMemories, getPendingTasks, listHires } from './_supabase-memory.mjs';

export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    initAgents();
    initConnectors();

    let action = 'list';
    let body = {};

    if (req.method === 'POST') {
      try { body = await req.json(); } catch { body = {}; }
      action = body.action || 'list';
    }

    switch (action) {
      case 'list':
        return await handleList(corsHeaders);

      case 'delegate':
        return await handleDelegate(body, corsHeaders);

      case 'execute':
        return await handleExecute(body, corsHeaders);

      case 'memory':
        return await handleMemory(body, corsHeaders);

      case 'connectors':
        return await handleConnectors(corsHeaders);

      case 'tasks':
        return await handleTasks(body, corsHeaders);

      case 'hire':
        return await handleHire(body, corsHeaders);

      case 'team':
        return await handleTeam(body, corsHeaders);

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
  } catch (err) {
    console.error('[workforce] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/workforce" };

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleList(corsHeaders) {
  const agents = await getAgentStatuses();
  const connectors = listConnectors().map(c => ({
    name: c.name,
    description: c.description,
    toolCount: c.tools.length,
    tools: c.tools.map(t => t.name)
  }));

  return new Response(JSON.stringify({
    workforce: agents,
    connectors,
    total_agents: agents.length,
    total_connectors: connectors.length,
    timestamp: new Date().toISOString()
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleDelegate(body, corsHeaders) {
  const { objective, context = {} } = body;
  if (!objective) {
    return new Response(JSON.stringify({ error: 'objective is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const manager = getAgent('manager');
  const result = await manager.execute({ objective, context });

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleExecute(body, corsHeaders) {
  const { agent: agentId, objective, context = {} } = body;
  if (!agentId || !objective) {
    return new Response(JSON.stringify({ error: 'agent and objective are required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const agent = getAgent(agentId);
  if (!agent) {
    return new Response(JSON.stringify({ error: `Unknown agent: ${agentId}`, available: Object.keys(listAgents()) }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const result = await agent.execute({ objective, context });
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleMemory(body, corsHeaders) {
  const { operation, ...params } = body;

  switch (operation) {
    case 'remember': {
      const result = await remember(params);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    case 'recall': {
      const result = await recall(params);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    case 'account': {
      const result = await getAccountMemories(params);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    default:
      return new Response(JSON.stringify({ error: 'Unknown memory operation. Use: remember, recall, account' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
  }
}

async function handleConnectors(corsHeaders) {
  const connectors = listConnectors();
  return new Response(JSON.stringify({
    connectors,
    total: connectors.length
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleTasks(body, corsHeaders) {
  const { agentId } = body;
  const tasks = await getPendingTasks({ agentId: agentId || 'manager', limit: 20 });
  return new Response(JSON.stringify({ tasks, count: tasks.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

/**
 * Hire a worker onto the team. Persists a hire record (the shared "Your Team"
 * roster, surfaced in Mission Control) and marks the worker active.
 */
async function handleHire(body, corsHeaders) {
  const { agent: agentId, company, goal, context = '', tools = [] } = body;
  if (!agentId || !company || !goal) {
    return new Response(JSON.stringify({ error: 'agent, company, and goal are required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const agent = getAgent(agentId);
  if (!agent) {
    return new Response(JSON.stringify({ error: `Unknown agent: ${agentId}`, available: Object.keys(listAgents()) }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const hiredAt = new Date().toISOString();
  const accountId = String(company).toLowerCase().replace(/\s+/g, '_');
  const profile = {
    agent_id: agent.id, name: agent.name, title: agent.title, type: agent.type,
    avatar: agent.avatar, bio: agent.bio, skills: agent.skills, tools: agent.tools
  };

  // Persist the hire to shared memory (no embedding — this is a structured record)
  await remember({
    agentId: agent.id,
    accountId,
    memoryType: 'hire',
    embed: false,
    content: `Hired ${agent.name} (${agent.title}) for ${company} — goal: ${goal}`,
    metadata: { ...profile, company, goal, context, tools, status: 'active', hired_at: hiredAt }
  });

  // Reflect the hire in the live registry so the fleet shows the worker active
  try { await agent.updateStatus('active', goal, `Hired by ${company}`); } catch (e) { /* best-effort */ }

  return new Response(JSON.stringify({
    success: true,
    hired: { ...profile, company, goal, status: 'active', hired_at: hiredAt }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

/**
 * Return the hired-worker roster ("Your Team"), optionally scoped to a company.
 */
async function handleTeam(body, corsHeaders) {
  const accountId = body.accountId ? String(body.accountId).toLowerCase().replace(/\s+/g, '_') : null;
  const team = await listHires({ accountId, limit: 100 });
  return new Response(JSON.stringify({ team, count: team.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
