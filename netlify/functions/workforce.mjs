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
import { remember, recall, getAccountMemories, getPendingTasks } from './_supabase-memory.mjs';
import { withCors, isInternalCall } from './_auth.mjs';
import { requireOperator, readRequestedTenantId, isHomeTenant, denyStealthMutation } from './_tenant.mjs';

const __handler = async (req, context) => {
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

    const stealthDenied = await denyStealthMutation(req, { tenantId: readRequestedTenantId(req).id }, undefined, action);
    if (stealthDenied) return stealthDenied;

    // SECURITY: only the read-only roster is public (workers.html, MC hire
    // modal), and it is sanitized for anonymous callers. Every action that
    // runs agents, reads/writes the global agent memory or lists tasks is
    // platform-operator only; workforce-hires may call delegate/execute with
    // the internal service token on behalf of an authenticated tenant.
    let privileged = false;
    if (action === 'list') {
      const auth = req.headers.get('authorization');
      if (isInternalCall(req)) privileged = true;
      else if (auth) privileged = !(await requireOperator(req, { allowInternal: false })).response;
    } else {
      const internalOk = isInternalCall(req) && (action === 'delegate' || action === 'execute');
      if (!internalOk) {
        const g = await requireOperator(req, { allowInternal: false });
        if (g.response) return g.response;
      }
    }

    // The shared workforce (live task text, pending tasks, global agent
    // memory) belongs to the operator's own account. A Mission Control
    // workspace scoped to another tenant (?tenant_id=) gets the sanitized
    // roster, an empty task list, and no access to shared memory or runs.
    const scope = readRequestedTenantId(req);
    const scopedAway = !isInternalCall(req) && (!!scope.invalid || (!!scope.id && !isHomeTenant(scope.id)));
    if (scopedAway && action === 'tasks') {
      return new Response(JSON.stringify({ tasks: [], count: 0, scoped_tenant_id: scope.id || null }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (scopedAway && ['delegate', 'execute', 'memory'].includes(action)) {
      return new Response(JSON.stringify({ error: 'forbidden', reason: 'shared_workforce_home_account_only' }), {
        status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    switch (action) {
      case 'list': {
        return await handleList(corsHeaders, { full: privileged && !scopedAway });
      }

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

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
  } catch (err) {
    console.error('[workforce] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/workforce", rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleList(corsHeaders, { full = false } = {}) {
  let agents = await getAgentStatuses();
  if (!full) {
    // Anonymous roster: drop live task text (may contain tenant objectives).
    agents = (agents || []).map(({ current_task, last_action, currentTask, lastAction, memory, ...rest }) => rest);
  }
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

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
