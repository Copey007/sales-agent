/**
 * Shared input guards for the public concierge (and avatar-chat when present).
 * Caps history and allows only user/assistant roles.
 *
 * Public slugs default to a-gent,demo via PUBLIC_CONCIERGE_SLUGS. Tenant
 * /a/<slug> widgets are not served to anonymous callers unless that slug is
 * added to the allowlist (or a future is_public flag is added).
 */


export const MAX_CHAT_MESSAGES = 12;
export const MAX_CHAT_CHARS = 2000;
export const MAX_CHAT_TOTAL_CHARS = 8192;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

/**
 * @returns {{ messages: {role:string,content:string}[] } | { error: string, status: number }}
 */
export function sanitizeChatMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'messages_required', status: 400 };
  }
  // Keep the most recent window first, then validate that window.
  const windowed = input.slice(-MAX_CHAT_MESSAGES);
  const messages = [];
  let total = 0;
  for (const raw of windowed) {
    const role = raw?.role;
    if (!ALLOWED_ROLES.has(role)) {
      return { error: 'invalid_role', status: 400 };
    }
    const content = String(raw?.content ?? '');
    if (content.length > MAX_CHAT_CHARS) {
      return { error: 'message_too_long', status: 413 };
    }
    total += content.length;
    if (total > MAX_CHAT_TOTAL_CHARS) {
      return { error: 'history_too_large', status: 413 };
    }
    messages.push({ role, content });
  }
  if (!messages.length) return { error: 'messages_required', status: 400 };
  return { messages };
}

export function publicConciergeSlugs(env = process.env) {
  const raw = env.PUBLIC_CONCIERGE_SLUGS || 'a-gent,demo';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function isPublicConciergeSlug(slug, env = process.env) {
  return publicConciergeSlugs(env).has(String(slug || ''));
}
