/**
 * GET /api/mcp/account-status — MCP Phase A `account_status` (read-only).
 * Aggregates campaign-orchestrator status, campaign-admin status and
 * workforce-hires for ONE explicitly-named tenant. See _mcp-read.mjs and
 * /workspace/handoffs/mcp-phase-a-contract.md.
 */
import { mcpReadEndpoint, accountStatus } from './_mcp-read.mjs';

export const config = { path: '/api/mcp/account-status' };
export default mcpReadEndpoint(accountStatus);
