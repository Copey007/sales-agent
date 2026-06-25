/**
 * Manager Heartbeat — Scheduled Workforce Autopilot
 * 
 * Runs every 30 minutes. The Manager agent wakes up, assesses the system state,
 * and delegates tasks to specialist agents:
 *   - Ops: system health check (queue depth, sent counts)
 *   - Support: classify any unclassified inbound replies
 *   - Success: customer health assessment (at-risk detection)
 * 
 * Results are stored as memories in Supabase and visible in Mission Control
 * via the agent_registry status updates.
 * 
 * Scheduled via netlify.toml: schedule = "every 30 minutes"
 * IMPORTANT: This function MUST NOT have `path` in its config export
 * (Netlify rejects scheduled functions with path).
 */

import { initAgents, getAgent } from './_agent-registry.mjs';
import { initConnectors, invoke, env } from './_mcp-connectors.mjs';
import { remember, getPendingTasks } from './_supabase-memory.mjs';

export default async (req, context) => {
  console.log('[heartbeat] Manager heartbeat starting...');

  const startTime = Date.now();

  try {
    initAgents();
    initConnectors();

    const manager = getAgent('manager');

    // ─── 1. System Health (Ops Agent) ──────────────────────────────
    let opsResult = null;
    try {
      const ops = getAgent('ops');
      opsResult = await ops.execute({ 
        objective: 'System health check — report queue depth, sent counts, and daily limits',
        context: {} 
      });
      console.log('[heartbeat] Ops check complete:', opsResult?.statusBreakdown);
    } catch (e) {
      console.warn('[heartbeat] Ops check failed:', e.message);
      opsResult = { success: false, error: e.message };
    }

    // ─── 2. Reply Classification (Support Agent) ────────────────
    let supportResult = null;
    try {
      const support = getAgent('support');
      supportResult = await support.execute({
        objective: 'Classify recent unclassified inbound replies',
        context: { action: 'classify_replies' }
      });
      console.log('[heartbeat] Support reply classification:', supportResult?.classified_count, 'classified,', supportResult?.escalations?.length, 'escalations');
    } catch (e) {
      console.warn('[heartbeat] Support classification failed:', e.message);
      supportResult = { success: false, error: e.message };
    }

    // ─── 3. Customer Health (Success Agent) ──────────────────────
    let successResult = null;
    try {
      const success = getAgent('success');
      successResult = await success.execute({
        objective: 'Assess customer health — identify at-risk accounts, suggest retention actions',
        context: {}
      });
      console.log('[heartbeat] Success health check:', successResult?.health, successResult?.metrics);
    } catch (e) {
      console.warn('[heartbeat] Success check failed:', e.message);
      successResult = { success: false, error: e.message };
    }

    // ─── 4. Summarize and store as memory ────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = {
      ops: opsResult?.success ? {
        totalSteps: opsResult.totalSteps,
        sent: opsResult.statusBreakdown?.sent || 0,
        queued: opsResult.statusBreakdown?.queued || 0,
        contacts: opsResult.totalContacts
      } : { error: opsResult?.error },
      support: supportResult?.success ? {
        classified: supportResult.classified_count,
        escalations: supportResult.escalations?.length || 0
      } : { error: supportResult?.error },
      success: successResult?.success ? {
        health: successResult.health,
        replyRate: successResult.metrics?.replyRate,
        staleContacts: successResult.metrics?.staleContacts
      } : { error: successResult?.error }
    };

    try {
      await remember({
        agentId: 'manager',
        memoryType: 'campaign_result',
        content: `Heartbeat ${new Date().toISOString()}: Ops=${summary.ops.sent || 0} sent/${summary.ops.queued || 0} queued. Support=${summary.support.classified || 0} classified/${summary.support.escalations || 0} escalations. Success=${summary.success.health || 'unknown'}, reply rate ${summary.success.replyRate || 0}%, ${summary.success.staleContacts || 0} stale. Elapsed ${elapsed}s.`,
        metadata: summary,
        embed: false
      });
    } catch (e) {
      console.warn('[heartbeat] Memory storage failed:', e.message);
    }

    console.log(`[heartbeat] Complete in ${elapsed}s. Ops: ${summary.ops.sent || 'err'}. Support: ${summary.support.classified || 'err'}. Success: ${summary.success.health || 'err'}.`);

    return new Response(JSON.stringify({
      success: true,
      elapsed_seconds: parseFloat(elapsed),
      summary,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[heartbeat] FATAL:', err.message, err.stack);
    return new Response(JSON.stringify({ 
      success: false, 
      error: err.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Scheduled function config — NO path (Netlify rejects path+schedule)
export const config = { schedule: "*/30 * * * *" };
