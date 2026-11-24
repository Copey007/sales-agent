// Clearly fake seed data for LOCAL preview screenshots only (never prod).
const now = Date.now(), iso = (h) => new Date(now + h * 3600e3).toISOString();
const N = 8, pad = (i) => String(i).padStart(2, '0');
const contacts = Array.from({ length: N }, (_, i) => ({ id: `c${i + 1}`, first_name: 'Test', last_name: `Prospect ${pad(i + 1)}`, name: `Test Prospect ${pad(i + 1)}`, email: `test.prospect${pad(i + 1)}@example.com`, company: i % 2 ? 'Example Corp' : 'Example Industries', title: ['VP Sales', 'Head of RevOps', 'CRO', 'Sales Director'][i % 4], created_at: iso(-200 + i) }));
const sequences = contacts.map((c, i) => ({ id: `s${i + 1}`, contact_id: c.id, name: `Example sequence ${pad(i + 1)}`, status: i % 3 ? 'active' : 'paused', created_at: iso(-190 + i) }));
const ST = ['sent', 'opened', 'replied', 'queued', 'queued', 'delivered'];
const email_steps = sequences.flatMap((s, i) => Array.from({ length: 3 }, (_, k) => ({ id: `e${i + 1}-${k + 1}`, sequence_id: s.id, step_number: k + 1, status: ST[(i + k) % ST.length], subject: `Example subject ${k + 1} for Test Prospect ${pad(i + 1)}`, body: `Hi Test,\n\nThis is fake example copy for step ${k + 1}. Example Corp would see a short note here.\n\n— Example Sender`, scheduled_at: iso(k * 24 - 10 + i), sent_at: ST[(i + k) % ST.length] === 'queued' ? null : iso(-20 + i) })));
const activity_log = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, action: ['email_sent', 'reply_received', 'sequence_started'][i % 3], detail: `Fake activity ${i + 1} for Test Prospect ${pad((i % N) + 1)}`, timestamp: iso(-i), agent: 'Example SDR' }));
const metrics = [['emails_sent', 42], ['open_rate', 61], ['reply_rate', 9], ['meetings', 3]].map(([metric_name, value], i) => ({ id: i + 1, metric_name, value, metric_value: value }));
const row = (c, i, st) => ({ name: c.name, email: c.email, company: c.company, step: (i % 3) + 1, campaign: 'Example Q4 Outbound', subject: `Example subject for ${c.name}`, status: st, scheduled_at: iso(i + 1), sent_at: iso(-i - 1) });
const pipeline = { totals: { sent: 42, queued: 12, replied: 4 }, campaigns_active: 2, last_send_at: iso(-1), queued_rows: contacts.slice(0, 5).map((c, i) => row(c, i, 'queued')), sent_rows: contacts.slice(3).map((c, i) => row(c, i, ['sent', 'opened', 'replied'][i % 3])) };
const campaigns = [
  { id: 'camp1', name: 'Example Q4 Outbound', status: 'active', persona: 'RevOps leaders', created_at: iso(-300), contacts_enrolled: 1240, awaiting: 310, queued: 12, sent: 42, replied: 4, metrics: { prospects_enrolled: 1240, queued_sends: 12, sent_today: 18 },
    sequence: { steps: [1, 2, 3].map((n) => ({ subject_template: `Example step ${n} subject`, delay_days: (n - 1) * 3, type: 'email', body_template: `Hi {{first_name}}, fake example body for step ${n}. Example Corp copy only.` })) } },
  { id: 'camp2', name: 'Example Partner Pilot', status: 'ready', persona: 'Agency founders', created_at: iso(-150), contacts_enrolled: 320, queued: 0, sent: 0, replied: 0, metrics: { prospects_enrolled: 320, queued_sends: 0, sent_today: 0 } },
  { id: 'camp3', name: 'Example Winback (paused)', status: 'paused', persona: 'Past trials', created_at: iso(-90), contacts_enrolled: 88, queued: 3, sent: 61, replied: 7, metrics: { prospects_enrolled: 88, queued_sends: 3, sent_today: 0 } },
];
const orch = {
  status: { campaigns },
  funnel: { sourced: 1240, queued: 12, sent: 42, delivered: 40, opened: 26, replied: 4, positive: 2 },
  prospects: { prospects: contacts.map((c, i) => ({ ...c, position: c.title, verified: i % 3 !== 0 })) },
  sends: { sends: contacts.slice(0, 6).map((c, i) => ({ prospect_email: c.email, subject: `Example subject for ${c.name}`, status: ['sent', 'opened', 'replied', 'queued', 'delivered', 'bounced'][i], sent_at: i === 3 ? null : iso(-i - 1) })) },
  replies: { replies: contacts.slice(0, 3).map((c, i) => ({ from_name: c.name, from_email: c.email, subject: `Re: Example subject ${i + 1}`, sentiment: ['positive', 'neutral', 'not_now'][i], text_body: `Fake reply ${i + 1}: thanks, this is example text only.`, received_at: iso(-i) })) },
  loop: { baseline: { version: 3, score: 71.4 }, experiments: [1, 2, 3].map((n) => ({ variant_description: `Example variant ${n}: shorter opener`, baseline_score: 68 + n, variant_score: 66 + n * 2, score_delta: n * 2 - 2, decision: n === 2 ? 'keep' : 'revert' })) },
};
const hires = [
  { id: 'h1', name: 'Example SDR Worker', title: 'Outbound SDR', status: 'active', goal: 'Book 5 example meetings a week', avatar: '🤖', activity: [{ action: 'Drafted 3 outreach emails', detail: 'For Test Prospect 01–03 at Example Corp' }, { action: 'Researched Example Industries' }] },
  { id: 'h2', name: 'Example Research Worker', title: 'Researcher', status: 'paused', goal: 'Find example.com leads', avatar: '🔎', last_activity: 'Paused by operator' },
];
const drafts = contacts.slice(0, 3).map((c, i) => ({ id: `d${i + 1}`, worker_name: 'Example SDR Worker', prospect_name: c.name, prospect_email: c.email, prospect_company: c.company, from_email: 'sdr@example.com', subject: `Example subject ${i + 1} for ${c.name}`, body: `Hi Test,\n\nThis is a fake draft (${i + 1}) awaiting review. Example Corp only.\n\n— Example SDR Worker` }));
const json = (b, s = 200) => ({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
export function respond(url) {
  const u = new URL(url);
  if (u.hostname.endsWith('supabase.co')) {
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: 'u-fake', email: 'operator@example.com' });
    const t = u.pathname.split('/rest/v1/')[1]?.split('?')[0];
    const map = { contacts, sequences, email_steps, activity_log, metrics };
    if (t) return json(map[t] || []);
    return json({});
  }
  if (u.pathname.startsWith('/api/')) {
    const a = u.searchParams.get('action'), ep = u.pathname.slice(5);
    if (ep === 'campaign-admin') return json(a === 'pipeline_stats' ? pipeline : a === 'campaigns_overview' ? { campaigns } : { ok: true });
    if (ep === 'campaign-orchestrator') return json(orch[a] || {});
    if (ep === 'workforce-hires') return json({ hires, trial: { days_left: 9 } });
    if (ep === 'worker-outreach') return json({ drafts });
    if (ep === 'agent-config') { const slug = u.searchParams.get('slug') || ''; const pc = { 'dark-demo': '#1a2b4c', 'mid-demo': '#4f7cff', 'grey-demo': '#777777' }[slug] || '#c8b48c'; return json({ config: { slug, name: 'Example Agent', greeting: 'Hi! I am a fake example agent.', chips: ['What does Example Corp do?', 'Book a demo'], theme: { primary_color: pc, headline: `Example Agent (${slug})`, subcopy: 'Fake tenant theme for contrast testing.' } } }); }
    if (ep === 'loop-engine') return json({ experiments: orch.loop.experiments, baseline: orch.loop.baseline });
    return json({});
  }
  return null;
}
