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
  if (env('WORKER_RUNTIME_AUTO') !== '1') {
    return new Response(JSON.stringify({ skipped: 'auto disabled' }), { headers: { 'Content-Type': 'application/json' } });
  }
  let result = {};
  try { result = await runDueWorkers(); } catch (e) { console.error('[worker-runtime-cron]', e.message); result = { error: e.message }; }
  return new Response(JSON.stringify({ ok: true, ...result }), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/30 * * * *' };
