/**
 * Who may mint or chat for an avatar agent.
 *
 * Public allowlisted slugs (default a-gent, demo) may be used anonymously,
 * which keeps /agent.html, /a/demo and /a/a-gent working. Any other slug
 * requires a signed-in member of that agent's tenant (or a platform
 * operator). Internal tokens are not a substitute for membership.
 */
import { isPublicConciergeSlug } from './_chat-input.mjs';
import { resolveTenantContext, canAccessTenant } from './_tenant.mjs';

export function isPublicAvatarSlug(slug) {
  return isPublicConciergeSlug(slug);
}

/**
 * Require a signed-in tenant member or operator. Does not check which tenant.
 * @returns {{ ok: true, ctx: object } | { ok: false, status: number, error: string, reason?: string }}
 */
export async function requireAvatarLogin(req) {
  let ctx;
  try {
    ctx = await resolveTenantContext(req);
  } catch (err) {
    return { ok: false, status: 503, error: 'usage_store_unavailable' };
  }
  if (ctx.internal) return { ok: false, status: 403, error: 'forbidden' };
  if (ctx.invalid) {
    return {
      ok: false,
      status: ctx.status || 401,
      error: ctx.status === 403 ? 'forbidden' : 'unauthorized',
      reason: ctx.reason,
    };
  }
  return { ok: true, ctx };
}

/**
 * Public slug: allowed anonymously. Private slug: the caller must be a
 * member of `tenantId` (or an operator).
 */
export async function authorizeAvatarAgent(req, { slug, tenantId }) {
  if (isPublicAvatarSlug(slug)) return { ok: true, public: true };
  const login = await requireAvatarLogin(req);
  if (!login.ok) return login;
  if (!canAccessTenant(login.ctx, tenantId)) {
    return { ok: false, status: 404, error: 'agent_not_found' };
  }
  return { ok: true, ctx: login.ctx };
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
