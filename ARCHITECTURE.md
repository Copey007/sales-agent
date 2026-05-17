# A-Gent — AI Sales Agent with Built-in Workflow Intelligence

## The Concept

**One product** — A-Gent starts as a free workflow tracker and upgrades when users "turn on" automations.

**Problem:** Sales people spend too much time on manual, repetitive tasks. They don't know what to automate first or how to get started.

**Solution:** A-Gent tracks workflows (time, clicks, patterns), shows automation opportunities, and lets users enable automations one at a time.

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
Automation activates ($9/mo)
         ↓
See time savings → enable more → Full AI Agent ($99/mo)
```

---

## Pricing

### Free — The Eye-Opener
Install A-Gent and it tracks your workflows for free.

| Feature | Details |
|---------|---------|
| Workflow tracking | Time in each app |
| Click counting | Clicks within apps |
| Daily popup | Quick stats |
| Weekly dashboard | Patterns and trends |
| **1 free automation** | Try one to see value |

### Automation Modules — $9/mo each
Turn on only what you need:

| Automation | What it does |
|------------|---------------|
| **CRM Auto-Sync** | Salesforce/HubSpot auto-update |
| **Email Sequences** | Follow-up automation |
| **Contact Enrichment** | Hunter.io email finding |
| **Account Research** | AI-powered company research |
| **Signal Detection** | Funding/hiring/exec change alerts |

**Pro Bundle:** $29/mo (all 5 automations)

### Full AI Agent — $99/mo
Everything in Pro plus:
- Proactive prospect finding
- Signal-triggered outreach
- Unlimited account monitoring
- Priority support
- Ongoing AI optimization

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
Bundle all 5 ($29/mo) → Pro
         ↓
Want proactive AI → Full Agent ($99/mo)
```

---

## What's Included in Free

A-Gent free is the eye-opener. It shows users:
- Where their time goes
- How many clicks they make
- What repetitive tasks they do
- Where automation opportunities exist

Then the upgrade conversation writes itself: "You spend 4.5 hours/week on manual Salesforce updates — we automate that for $9/mo."

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
- ✅ Chrome extension (scaffold)
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