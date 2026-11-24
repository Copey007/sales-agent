/**
 * Worker Runtime — scheduled driver.
 *
 * Runs on a cron and advances each due active worker by one cycle, but ONLY when
 * WORKER_RUNTIME_AUTO=1 (autonomous LLM/Hunter spend is opt-in). Otherwise no-op.
 * The actual work lives in worker-runtime.mjs (also the /api/worker-runtime
 * "Run now" endpoint), so manual and scheduled paths share one implementation.
 */

import { env } from './_mcp-connectors.mjs';
import { runDueWorkers } from './worker-runtime.mjs';

export default async () => {
  // Full autonomy (every worker, hourly) stays opt-in via WORKER_RUNTIME_AUTO=1.
  // But pipeline supervision is the Mission Control Manager's standing
  // RESPONSIBILITY — manager hires run their cycle (health sweep + planning)
  // on this cron regardless, so stranded work is found and repaired even when
  // the rest of the workforce is in manual mode.
  const full = env('WORKER_RUNTIME_AUTO') === '1';
  let result = {};
  try {
    result = await runDueWorkers({ rolesOnly: full ? null : ['manager'] });
  } catch (e) { console.error('[worker-runtime-cron]', e.message); result = { error: e.message }; }
  return new Response(JSON.stringify({ ok: true, mode: full ? 'all_workers' : 'manager_only', ...result }), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/30 * * * *' };
