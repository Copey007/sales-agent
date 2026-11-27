// Server-side gate for the internal aisdr dashboards (2026-11 lockdown).
// Anonymous / non-operator requests get a small login shell — never the
// dashboard HTML. Public pages (signup, offers-demo, hosted avatar /a/<slug>,
// concierge/demo/copilot widgets, workers marketplace) are NOT gated.
import { handleGate } from '../edge-lib/gate-core.mjs';

export default (request, context) => handleGate(request, {
  env: (k) => Netlify.env.get(k),
  fetchImpl: fetch,
  next: () => context.next(),
  title: 'AskArlen AI SDR — Operator sign-in',
  subtitle: 'Operator access only. Sign in to open the AI SDR dashboard.',
  storageKey: 'agent_auth_session_v1',
  requireOperator: true,
  reviewUrl: 'https://missioncontrol.askarlen.com',
});

export const config = {
  // /auth/handoff + /auth/logout: cross-domain SSO peer routes for
  // missioncontrol.askarlen.com (see gate-core handoffPage/logoutPage).
  path: ['/', '/index.html', '/index', '/dashboard', '/dashboard/*', '/auth/handoff', '/auth/logout'],
  cache: 'manual',
};
