# A-Gent — AI Sales Agent with Built-in Workflow Intelligence

**One product.** Starts free, tracks workflows, upgrades when you "turn on" automations.

---

## What is A-Gent?

**Problem:** Sales people spend 40%+ of their time on repetitive manual tasks. They don't know what to automate first or how to get started.

**Solution:** A-Gent tracks your workflows (time, clicks, patterns), shows automation opportunities, and lets you enable them one at a time.

---

## How It Works

```
Install A-Gent (free)
         ↓
Agent tracks workflows in background
         ↓
Dashboard shows:
  - "You spent 4.5 hrs/week manually updating Salesforce"
  - "You do 18 repetitive tasks/week"
  - "These are automation candidates"
         ↓
Click "Turn on" on any automation
         ↓
Automation activates ($9-29/mo)
         ↓
See time savings → enable more → Full AI Agent ($99/mo)
```

---

## Pricing

| Tier | Price | What's Included |
|------|-------|-----------------|
| **Free** | $0 | Workflow tracking, 1 account, basic research, 1 free automation |
| **Pro** | $29/mo | All automation modules, unlimited accounts, full dashboard |
| **Full AI Agent** | $99/mo | Everything + proactive AI agent |

---

## Core Features

### Workflow Tracking (Free)
- Chrome extension tracks time + clicks
- Daily popup summary
- Weekly dashboard with patterns
- Automation opportunity detection

### Account Research (Free)
- Company research via Serper API
- Contact discovery
- Signal detection (funding, hiring, exec changes)

### Email Outreach (Pro)
- Personalized email sequences
- CRM auto-sync
- Follow-up automation

### AI SDR (Full Agent)
- Proactive prospect finding
- Signal-triggered outreach
- Full sales automation

---

## Automation Modules

Each can be turned on/off independently:

- **CRM Auto-Sync** — Salesforce/HubSpot auto-update ($9/mo)
- **Email Follow-ups** — Sequence automation ($9/mo)
- **Contact Enrichment** — Hunter.io email finding ($9/mo)
- **Signal Detection** — Intent monitoring + alerts ($9/mo)
- **Report Generation** — Weekly summaries ($9/mo)

Bundle all 5 for $29/mo (Pro tier)

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

## Quick Start

```bash
# Research an account
node cli.js "research acme corp"

# Send outreach
node cli.js "prospect acme corp"

# Scan for signals
node cli.js "scan accounts"

# Check what we know
node cli.js "check acme corp"
```

---

## Structure

```
sales-agent/
├── extension/           # Chrome extension
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html
│   └── popup.js
├── core/                # Agent brain
│   ├── agent.js
│   ├── task_queue.js
│   └── skills.js
├── capabilities/        # Skills
│   ├── research.js
│   ├── sdr.js
│   ├── signals.js
│   └── workflow_tracker.js
├── integrations/        # APIs
│   ├── crm.js
│   ├── email.js
│   ├── email_enrichment.js
│   └── web_search.js
├── dashboard/           # Web UI
│   ├── index.html
│   └── dashboard.html
└── memory/             # Storage
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
- ✅ Chrome extension (scaffold)
- ✅ Web dashboard (ready to deploy)

**To deploy:**
- Netlify dashboard (manual 2-min step)

**Next to build:**
- Automation "turn on" flow
- Payment integration (Stripe)
- Chrome Web Store listing

---

## Links

- **Repo:** https://github.com/Copey007/sales-agent
- **Dashboard:** (deploy to Netlify)
- **GTM Revolution:** https://gtmrevolution.com

---

*Part of the GTM Revolution ecosystem — workflow intelligence meets AI sales automation.*