# A-Gent — AI Sales Agent with Built-in Workflow Intelligence

## The Concept

**One product** — A-Gent starts as a free workflow tracker and upgrades when users "turn on" automations.

**Problem:** Sales people spend too much time on manual, repetitive tasks but don't know what to prioritize or how to automate.

**Solution:** A-Gent tracks workflows (time, clicks, patterns), shows automation opportunities, and lets users enable automations one by one as they see value.

**Positioning:** "Your AI sales agent that learns your workflows and automates them — one step at a time."

---

## The Product

### Base (Free)
- **Workflow tracking:** time in apps, clicks, patterns
- **Account research:** company info, contacts, signals
- **Basic dashboard:** see where time goes
- **1 automation unlocked** (user picks 1 free automation)

### Pro ($29/mo — "Turn on Automations")
Users enable specific automations:
- CRM auto-sync
- Email follow-up sequences
- Contact enrichment
- Signal detection
- Report generation

Each automation unlocked separately, or bundle for $29/mo.

### Full AI Agent ($99/mo)
All automations enabled + ongoing AI agent that:
- Proactively finds prospects
- Sends outreach based on signals
- Updates CRM automatically
- Generates weekly reports

---

## How It Works

```
User installs A-Gent (free)
         ↓
Agent tracks workflows in background
         ↓
Dashboard shows:
  - "You spent 4.5 hrs/week manually updating Salesforce"
  - "You send 15 similar follow-up emails/day"
  - "These 3 tasks are automation candidates"
         ↓
User clicks "Turn on" on any automation
         ↓
Automation activates → $29/mo
         ↓
User sees time savings → wants more → Full AI Agent → $99/mo
```

---

## Workflow Tracking

### Extension (Chrome)
- **Installs in 1 click** from Chrome Web Store
- **Tracks in background:** active tab, time, clicks, workflows
- **No screenshots, no surveillance** — just category + duration + event data
- **Daily popup:** "Today: 3.2 hrs tracked, 47 clicks, 5 workflows"
- **Dashboard:** weekly breakdown, patterns, automation opportunities

### What We Track

**Session Data:**
- Tab active time
- Category (email, crm, chat, docs, web, other)
- Domain and URL
- Click count during session

**Workflow Events:**
- Clicks within apps (Salesforce, HubSpot, Gmail)
- Action patterns (form submits, data entry, updates)
- Repetitive sequences

**Computed Insights:**
- Most time-consuming apps
- Repetitive task frequency
- Automation opportunity score
- Week-over-week trends

---

## Automation Modules

### 1. CRM Auto-Sync ($9/mo or bundle)
- Updates Salesforce/HubSpot automatically
- Syncs contacts, deals, activities
- No manual data entry

### 2. Email Follow-ups ($9/mo or bundle)
- Personalized follow-up sequences
- Triggers based on prospect behavior
- Templates auto-personalized

### 3. Contact Enrichment ($9/mo or bundle)
- Hunter.io for email finding
- Company data enrichment
- LinkedIn profile data

### 4. Signal Detection ($9/mo or bundle)
- Funding, hiring, exec changes
- Real-time alerts
- Trigger SDR actions

### 5. Prospect Research ($9/mo or bundle)
- Company research automation
- Contact discovery
- competitive intel

### 6. Report Generation ($9/mo or bundle)
- Weekly activity reports
- Pipeline summaries
- Custom dashboards

---

## Technical Architecture

```
A-Gent/
├── extension/           # Chrome extension for tracking
│   ├── manifest.json
│   ├── background.js    # Tracking service worker
│   ├── popup.html       # Mini dashboard popup
│   └── popup.js
├── core/                # Agent brain
│   ├── agent.js
│   ├── task_queue.js
│   └── skills.js
├── capabilities/        # Agent capabilities
│   ├── research.js
│   ├── sdr.js
│   ├── signals.js
│   └── workflow_tracker.js  # NEW: workflow analysis
├── integrations/       # External APIs
│   ├── crm.js          # HubSpot/Salesforce
│   ├── email.js        # SMTP/Gmail
│   ├── email_enrichment.js  # Hunter.io
│   └── web_search.js   # Serper
├── dashboard/          # Web dashboard
│   ├── index.html      # Landing/marketing
│   └── dashboard.html  # User dashboard
└── memory/             # Data storage
    ├── short_term.js
    ├── long_term.js
    └── working.js
```

---

## Data Model

```javascript
// User
User {
  id: uuid,
  email: string,
  plan: 'free' | 'pro' | 'full',
  automations: [string],  // enabled automation names
  created_at: timestamp
}

// Workflow Session
Session {
  id: uuid,
  user_id: uuid,
  start_time: timestamp,
  end_time: timestamp,
  category: string,
  domain: string,
  click_count: number
}

// Automation Opportunity (computed)
Opportunity {
  user_id: uuid,
  action: string,        // 'Manual Salesforce updates'
  frequency: string,     // '22x per week'
  time_saved: string,    // '2.5 hours/week'
  automation: string,    // 'CRM Auto-Sync'
  price: number          // $9/mo
}
```

---

## Pricing Tiers

| Tier | Price | What's Included |
|------|-------|-----------------|
| **Free** | $0 | Workflow tracking, 1 account, basic research, 1 free automation |
| **Pro** | $29/mo | All automation modules ($9 each), unlimited accounts, full dashboard |
| **Full AI Agent** | $99/mo | Everything in Pro + proactive AI agent + priority support |

**Upgrade path:** Free → Pro (when they enable 2+ automations) → Full AI Agent (when they want proactive automation)

---

## Launch Order

1. **Build:** A-Gent core (done) + Chrome extension (done) + dashboard (done)
2. **Deploy:** Landing page + dashboard to Netlify
3. **Launch:** Chrome Web Store listing for extension
4. **Track:** Install rate, automation enablement rate, conversion to Pro
5. **Iterate:** Add automation modules one by one based on demand

---

## Success Metrics

- Install rate (target: 100/week)
- Free → Pro conversion (target: 5%)
- Pro → Full AI Agent conversion (target: 15%)
- Automation modules enabled per user (target: 2+)
- Time saved reported by users

---

## Competitive Positioning

| Competitor | What | Limitation |
|------------|------|-------------|
| RescueTime | Time tracking | No automation |
| Zapier | Automation | Complex setup, no workflow intel |
| HubSpot | CRM + automation | Expensive, overkill for SMB |
| Salesbod (old) | Original concept | Tech wasn't ready |

**A-Gent wins because:**
1. One install = both tracking AND automation
2. Workflow data tells us what to automate (no guessing)
3. Turn on/off individual automations (not all-or-nothing)
4. Natural upgrade path (enable 1 → enable 2 → full agent)

---

## Next Steps

1. [ ] Merge extension into sales-agent repo
2. [ ] Update dashboard to show automation upsells
3. [ ] Add "Turn on" flow for automations
4. [ ] Create Chrome Web Store listing
5. [ ] Deploy to Netlify
6. [ ] Launch