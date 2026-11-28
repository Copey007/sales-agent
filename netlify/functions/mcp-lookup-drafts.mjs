/**
 * GET /api/mcp/lookup-drafts — MCP Phase A `lookup_drafts` (read-only).
 * Stable read shape over worker_outreach drafts and campaign-admin
 * list_pending. No approve/reject/send. See _mcp-read.mjs.
 */
import { mcpReadEndpoint, lookupDrafts } from './_mcp-read.mjs';

export const config = { path: '/api/mcp/lookup-drafts' };
export default mcpReadEndpoint(lookupDrafts);
