# A-Gent — AI Sales Agent with Built-in Workflow Intelligence

## The Concept

**One product** — A-Gent starts as a free workflow tracker and upgrades when users "turn on" automations.

**Problem:** Sales people spend too much time on manual, repetitive tasks. They don't know what to automate first or how to get started.

**Solution:** A-Gent tracks workflows (time, clicks, patterns), shows automation opportunities, and lets users enable automations one at a time.

---

## Pricing

### Free — The Eye-Opener
Install A-Gent and it tracks your workflows for free.

| Feature | What it means |
|---------|---------------|
| **Workflow tracking** | How much time in what applications |
| **Workflow tracking** | Specific areas of the app and user flows |
| **Click counting** | Where you spend your time |
| **Automation recommendations** | Dashboard shows what to automate |
| **1 free automation** | Try one to see value |

### $9/mo — Automation Modules (turn on one by one)

| Automation | What it does |
|-----------|-------------|
| **CRM Auto-Sync** | HubSpot/Salesforce auto-update |
| **Agentic Workflows** | A-Gent does the work or refines workflows |
| **Email Sequences** | Follow-up automation + email management |
| **Contact Enrichment** | Hunter.io email finding |
| **Account Research** | AI-powered company research |
| **Signal Detection** | Funding/hiring/exec change alerts |

**Pro Bundle:** $29/mo (all 6 automations)

### Full AI Agent — $99/mo
Everything in Pro plus:
- Proactive prospect finding
- Signal-triggered outreach
- Unlimited account monitoring
- Agentic workflows on all accounts
- Priority support
- Ongoing AI optimization

---

## How It Works

```
Install A-Gent (free)
         ↓
Agent tracks in background:
  - Time in applications
  - Specific areas within apps
  - Click patterns
         ↓
Dashboard shows:
  - "You spent 4.5 hrs/week in Salesforce"
  - "You clicked 'Update Contact' 67 times"
  - "These are automation candidates"
         ↓
Click "Turn on" on any automation
         ↓
A-Gent does the work for you
         ↓
See time savings → enable more → Full AI Agent ($99/mo)
```

---

## What's Tracked (Free)

A-Gent free shows users:
- Time spent in each application (email, CRM, chat, docs)
- Specific areas within apps (which tabs, which features)
- Click patterns (where they spend effort)
- Automation opportunities with savings estimates

The dashboard tells them: "You spend 4.5 hours/week on manual Salesforce updates — we automate that."

---

## What's Automated ($9/mo each)

Each automation module is independent — turn on only what you need:

- **CRM Auto-Sync:** Automatically updates HubSpot/Salesforce. No manual data entry.
- **Agentic Workflows:** A-Gent performs tasks or refines workflows based on patterns detected.
- **Email Sequences:** Automated follow-ups, personalized sequences, inbox management.
- **Contact Enrichment:** Finds emails, company data, LinkedIn profiles automatically.
- **Account Research:** AI researches companies, finds contacts, detects signals.
- **Signal Detection:** Monitors for funding, hiring, exec changes. Alerts you when intent signals fire.

---

## Upgrade Path

```
Install A-Gent (free)
         ↓
Tracks workflows + clicks
         ↓
User sees: "You do X manually Y times/week"
         ↓
Turn on 1 automation ($9/mo) → See value
         ↓
Bundle all 6 ($29/mo) → Pro
         ↓
Want proactive AI → Full Agent ($99/mo)
```

---

## Tech Stack

- **Agent:** Node.js, single-threaded, file-based memory
- **Extension:** Chrome Extension API (Manifest V3)
- **Dashboard:** Static HTML + API calls
- **Search:** Serper.dev (Google results)
- **Email:** SMTP/Gmail + Hunter.io for enrichment
- **Hosting:** Netlify (dashboard) + Mac mini (agent backend)
- **CRM:** HubSpot / Salesforce integration

---

## Structure

```
sales-agent/
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
│   └── workflow_tracker.js
├── integrations/        # External APIs
│   ├── crm.js
│   ├── email.js
│   ├── email_enrichment.js
│   └── web_search.js
├── dashboard/          # Web dashboard
│   ├── index.html
│   └── dashboard.html
└── memory/             # Data storage
    ├── short_term.js
    ├── long_term.js
    └── working.js
```

---

## Status

**Built and working:**
- ✅ Agent core (Telegram-ready)
- ✅ Account research (Serper API)
- ✅ Email enrichment (Hunter.io)
- ✅ Signal detection (cron job)
- ✅ Chrome extension (scaffold with tracking)
- ✅ Web dashboard (ready to deploy)

**To deploy:**
- Netlify dashboard (manual 2-min step)

**Next to build:**
- Automation "turn on" flow in dashboard
- Payment integration (Stripe)
- Chrome Web Store listing

---

## Links

- **Repo:** https://github.com/Copey007/sales-agent
- **Dashboard:** (deploy to Netlify)
- **GTM Revolution:** https://gtmrevolution.com

---

*Part of the GTM Revolution ecosystem — workflow intelligence meets AI sales automation.*