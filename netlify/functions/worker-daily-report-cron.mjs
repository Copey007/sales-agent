/**
 * Daily worker reports — scheduled driver. Emails each active worker's end-of-day
 * summary to the workspace owner, once a day. Gated behind WORKER_RUNTIME_AUTO=1.
 */

import { env } from './_mcp-connectors.mjs';
import { runDailyReports } from './worker-daily-report.mjs';

export default async () => {
  if (env('WORKER_RUNTIME_AUTO') !== '1') {
    return new Response(JSON.stringify({ skipped: 'auto disabled' }), { headers: { 'Content-Type': 'application/json' } });
  }
  let result = {};
  try { result = await runDailyReports(); } catch (e) { console.error('[daily-report-cron]', e.message); result = { error: e.message }; }
  return new Response(JSON.stringify({ ok: true, ...result }), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '0 21 * * *' };   // ~5pm ET daily
