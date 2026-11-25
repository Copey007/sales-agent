/**
 * Sites where the A-Gent avatar side panel may run.
 *
 * Keep this list the single source of truth for allow/deny. Adding a CRM is
 * a new entry here (id, label, kind, hosts / hostTest). The panel and the
 * future CRM hook should import from this module instead of hard-coding hosts.
 *
 * Launch CRMs: A-Gent CRM, HubSpot, Salesforce — plus Gmail.
 */

export const ALLOWED_SITES = [
  {
    id: 'gmail',
    kind: 'mail',
    label: 'Gmail',
    hosts: ['mail.google.com'],
  },
  {
    id: 'agent-crm',
    kind: 'crm',
    label: 'A-Gent CRM',
    hosts: ['crm.a-gent.co'],
    openUrl: 'https://crm.a-gent.co/',
  },
  {
    id: 'hubspot',
    kind: 'crm',
    label: 'HubSpot',
    hosts: ['app.hubspot.com', 'app-eu1.hubspot.com', 'app-ap1.hubspot.com'],
    hostTest: (host) => /^app(-[a-z0-9]+)?\.hubspot\.com$/i.test(host),
    openUrl: 'https://app.hubspot.com/',
  },
  {
    id: 'salesforce',
    kind: 'crm',
    label: 'Salesforce',
    hosts: ['*.lightning.force.com', '*.my.salesforce.com', '*.lightning.crmforce.mil'],
    openUrl: 'https://login.salesforce.com/',
  },
];

export function hostMatches(hostname, pattern) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const pat = String(pattern || '').toLowerCase();
  if (!host || !pat) return false;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1); // ".lightning.force.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pat;
}

export function siteForUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, site: null, host: '', url: url || '' };
  }
  for (const site of ALLOWED_SITES) {
    const listed = (site.hosts || []).some((p) => hostMatches(host, p));
    const custom = site.hostTest ? site.hostTest(host) : false;
    if (listed || custom) {
      return { allowed: true, site, host, url };
    }
  }
  return { allowed: false, site: null, host, url };
}

export function allowedCrmLabels() {
  return ALLOWED_SITES.filter((s) => s.kind === 'crm').map((s) => s.label);
}

export function allowedSitesSummary() {
  const mail = ALLOWED_SITES.filter((s) => s.kind === 'mail').map((s) => s.label);
  const crm = allowedCrmLabels();
  const parts = [...mail, ...crm];
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
